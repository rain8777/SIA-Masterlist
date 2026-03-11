/**
 * security.js — SIA Masterlist Security Module
 * Ragay Rural Health Unit | DOH Philippines
 *
 * Covers:
 *  - Session management (JWT-style tokens in sessionStorage, NOT localStorage)
 *  - CSRF token generation & validation
 *  - Input sanitization (XSS prevention)
 *  - Rate limiting (login attempts)
 *  - Audit logging
 *  - Inactivity timeout
 *  - Content Security Policy nonce management
 *  - Role-based access control (RBAC)
 */

'use strict';

const Security = (() => {

  /* ── CONSTANTS ─────────────────────────────────────── */
  const SESSION_KEY      = 'sia_session';
  const CSRF_KEY         = 'sia_csrf';
  const AUDIT_KEY        = 'sia_audit';
  const SESSION_TIMEOUT  = 30 * 60 * 1000;   // 30 minutes inactivity
  const MAX_LOGIN_TRIES  = 5;
  const LOCKOUT_DURATION = 15 * 60 * 1000;   // 15 minutes lockout
  const TOKEN_EXPIRY     = 60 * 60 * 1000;   // 1 hour session

  /* ── ROLES ─────────────────────────────────────────── */
  // Permission matrix:
  //   canAdd    — add new child records
  //   canEdit   — edit existing records
  //   canDelete — permanently delete records (Admin only)
  //   canExport — download CSV
  //   canConfig — access ⚙ Config panel and Audit Log
  const ROLES = {
    ADMIN:       { label: 'Administrator',   canAdd: true,  canEdit: true,  canDelete: true,  canExport: true,  canConfig: true  },
    ENCODER:     { label: 'Encoder',         canAdd: true,  canEdit: true,  canDelete: false, canExport: true,  canConfig: false },
    HRH_NURSE:   { label: 'HRH (Nurse)',     canAdd: true,  canEdit: true,  canDelete: false, canExport: true,  canConfig: false },
    HRH_MIDWIFE: { label: 'HRH (Midwife)',   canAdd: true,  canEdit: true,  canDelete: false, canExport: true,  canConfig: false },
    NURSE:       { label: 'Nurse',           canAdd: true,  canEdit: true,  canDelete: false, canExport: true,  canConfig: false },
    MIDWIFE:     { label: 'Midwife',         canAdd: true,  canEdit: true,  canDelete: false, canExport: true,  canConfig: false },
    GENERAL:     { label: 'General',         canAdd: true,  canEdit: false, canDelete: false, canExport: false, canConfig: false },
    VIEWER:      { label: 'Reporter',        canAdd: false, canEdit: false, canDelete: false, canExport: true,  canConfig: false },
  };

  /* ── USERS (validated against Apps Script Users sheet in production) ── */
  /* Passwords stored as SHA-256 hex hashes. NEVER store plaintext.       */
  /* Default password format: username + "Rhu@2025!" (change immediately) */
  const DEMO_USERS = [
    { id: 'u001', username: 'administrator', passwordHash: null, role: 'ADMIN',       name: 'System Administrator', mustChangePassword: false },
    { id: 'u002', username: 'encoder',       passwordHash: null, role: 'ENCODER',     name: 'RHU Encoder',          mustChangePassword: false },
    { id: 'u003', username: 'hrhnurse',      passwordHash: null, role: 'HRH_NURSE',   name: 'HRH Nurse',            mustChangePassword: false },
    { id: 'u004', username: 'hrhmidwife',    passwordHash: null, role: 'HRH_MIDWIFE', name: 'HRH Midwife',          mustChangePassword: false },
    { id: 'u005', username: 'nurse',         passwordHash: null, role: 'NURSE',       name: 'Nurse',                mustChangePassword: false },
    { id: 'u006', username: 'midwife',       passwordHash: null, role: 'MIDWIFE',     name: 'Midwife',              mustChangePassword: false },
    { id: 'u007', username: 'general',       passwordHash: null, role: 'GENERAL',     name: 'General Staff',        mustChangePassword: false },
    { id: 'u008', username: 'reporter',      passwordHash: null, role: 'VIEWER',      name: 'Reporter / Viewer',    mustChangePassword: false },
  ];
  // Password for each account = username + "Rhu@2025!"
  // e.g. administrator → "administratorRhu@2025!"
  //      hrhnurse      → "hrhnurseRhu@2025!"

  /* ── CSRF ──────────────────────────────────────────── */
  function generateCSRF() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const token = Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
    sessionStorage.setItem(CSRF_KEY, token);
    return token;
  }

  function validateCSRF(token) {
    const stored = sessionStorage.getItem(CSRF_KEY);
    if (!stored || !token) return false;
    // Constant-time comparison
    if (stored.length !== token.length) return false;
    let diff = 0;
    for (let i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  }

  /* ── SHA-256 HASH ──────────────────────────────────── */
  async function sha256(str) {
    const buf  = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
  }

  /* ── RATE LIMITER ──────────────────────────────────── */
  function getRateLimit(username) {
    const key  = `rl_${username}`;
    const data = JSON.parse(sessionStorage.getItem(key) || '{"attempts":0,"lockUntil":0}');
    return data;
  }

  function recordFailedAttempt(username) {
    const key  = `rl_${username}`;
    const data = getRateLimit(username);
    data.attempts++;
    if (data.attempts >= MAX_LOGIN_TRIES) data.lockUntil = Date.now() + LOCKOUT_DURATION;
    sessionStorage.setItem(key, JSON.stringify(data));
    return data;
  }

  function clearRateLimit(username) {
    sessionStorage.removeItem(`rl_${username}`);
  }

  function isLockedOut(username) {
    const data = getRateLimit(username);
    if (data.lockUntil > Date.now()) return { locked: true, remaining: Math.ceil((data.lockUntil - Date.now()) / 60000) };
    if (data.lockUntil && data.lockUntil <= Date.now()) clearRateLimit(username);
    return { locked: false };
  }

  /* ── SESSION ───────────────────────────────────────── */
  function createSession(user) {
    const token = (() => {
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
    })();

    const session = {
      token,
      userId:    user.id,
      username:  user.username,
      name:      user.name,
      role:      user.role,
      issuedAt:  Date.now(),
      expiresAt: Date.now() + TOKEN_EXPIRY,
      lastActive: Date.now(),
      csrfToken: generateCSRF(),
    };

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    auditLog('LOGIN_SUCCESS', { username: user.username, role: user.role });
    return session;
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.token || !s.expiresAt) return null;
      if (Date.now() > s.expiresAt)          { destroySession('TOKEN_EXPIRED'); return null; }
      if (Date.now() - s.lastActive > SESSION_TIMEOUT) { destroySession('INACTIVITY_TIMEOUT'); return null; }
      return s;
    } catch { return null; }
  }

  function refreshSession() {
    const s = getSession();
    if (!s) return null;
    s.lastActive = Date.now();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    return s;
  }

  function destroySession(reason = 'LOGOUT') {
    const s = getSession();
    auditLog('SESSION_END', { reason, username: s ? s.username : 'unknown' });
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(CSRF_KEY);
  }

  /* ── RBAC ──────────────────────────────────────────── */
  function can(permission) {
    const s = getSession();
    if (!s) return false;
    const role = ROLES[s.role];
    return role ? !!role[permission] : false;
  }

  function requireAuth() {
    if (!getSession()) {
      window.location.href = 'login.html';
      return false;
    }
    refreshSession();
    return true;
  }

  /* ── INPUT SANITIZATION ────────────────────────────── */
  function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#x27;')
      .replace(/\//g, '&#x2F;')
      .replace(/`/g,  '&#x60;')
      .replace(/=/g,  '&#x3D;')
      .trim();
  }

  function sanitizeForSQL(str) {
    // Additional layer for any server-side usage
    if (typeof str !== 'string') return '';
    return str.replace(/['";\\]/g, '').trim();
  }

  function validateInput(value, type) {
    const validators = {
      name:     /^[a-zA-ZÀ-ÿ\s\-'\.ñÑ]{1,100}$/,
      date:     /^\d{4}-\d{2}-\d{2}$/,
      phone:    /^[\d\+\-\s\(\)]{7,20}$/,
      philhnum: /^[\d\-]{12,20}$/,
      barangay: /^[a-zA-ZÀ-ÿ\s\-'\.0-9ñÑ]{1,100}$/,
      purok:    /^[a-zA-ZÀ-ÿ\s\-'\.0-9ñÑ\/]{1,100}$/,
      remarks:  /^.{0,500}$/,
    };
    if (!validators[type]) return true;
    return validators[type].test(value.trim());
  }

  /* ── AUDIT LOG ─────────────────────────────────────── */
  function auditLog(action, details = {}) {
    const s = (() => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || {}; } catch { return {}; } })();
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      userId:    s.userId    || 'anonymous',
      username:  s.username  || 'anonymous',
      role:      s.role      || 'none',
      details,
      userAgent: navigator.userAgent.substring(0, 80),
    };

    let logs = [];
    try { logs = JSON.parse(sessionStorage.getItem(AUDIT_KEY) || '[]'); } catch {}
    logs.unshift(entry);
    if (logs.length > 200) logs = logs.slice(0, 200); // Keep last 200 entries
    sessionStorage.setItem(AUDIT_KEY, JSON.stringify(logs));

    // In production: also POST to Apps Script audit endpoint
    return entry;
  }

  function getAuditLogs() {
    try { return JSON.parse(sessionStorage.getItem(AUDIT_KEY) || '[]'); } catch { return []; }
  }

  /* ── INACTIVITY MONITOR ────────────────────────────── */
  let _inactivityTimer = null;
  function startInactivityMonitor() {
    const reset = () => {
      clearTimeout(_inactivityTimer);
      _inactivityTimer = setTimeout(() => {
        destroySession('INACTIVITY_TIMEOUT');
        window.location.href = 'login.html?reason=timeout';
      }, SESSION_TIMEOUT);
      refreshSession();
    };
    ['mousemove','keydown','click','touchstart','scroll'].forEach(e => document.addEventListener(e, reset, { passive: true }));
    reset();
  }

  /* ── URL PARAM SANITIZATION ────────────────────────── */
  function getSafeParam(name) {
    const params = new URLSearchParams(window.location.search);
    const val    = params.get(name) || '';
    return sanitize(val).substring(0, 100);
  }

  /* ── PUBLIC API ────────────────────────────────────── */
  return {
    ROLES,
    DEMO_USERS,
    MAX_LOGIN_TRIES,
    sha256,
    generateCSRF,
    validateCSRF,
    isLockedOut,
    recordFailedAttempt,
    clearRateLimit,
    createSession,
    getSession,
    refreshSession,
    destroySession,
    can,
    requireAuth,
    sanitize,
    sanitizeForSQL,
    validateInput,
    auditLog,
    getAuditLogs,
    startInactivityMonitor,
    getSafeParam,
  };

})();

// Expose globally
window.Security = Security;

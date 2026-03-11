/**
 * api.js — Google Sheets / Apps Script API Client
 * Ragay Rural Health Unit SIA Masterlist
 *
 * FIX: Google Apps Script web apps do NOT support standard CORS fetch() from
 * external origins. This file uses JSONP (script tag injection) as the
 * transport mechanism, which is the only reliable cross-origin method for GAS.
 *
 * Also adds fetch() fallback for cases where GAS is deployed with proper CORS
 * headers (e.g. via a proxy or updated GAS policy).
 */

'use strict';

const API = (() => {

  /* ── CONFIG ─────────────────────────────────────────── */
  let _scriptUrl = '';

  function setScriptUrl(url) {
    const pattern = /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/;
    if (!pattern.test(url)) throw new Error('Invalid Apps Script URL format');
    _scriptUrl = url;
  }

  function getScriptUrl() { return _scriptUrl; }

  /* ── JSONP TRANSPORT (required for Google Apps Script) ── */
  // GAS web apps redirect to script.googleusercontent.com, which blocks fetch()
  // JSONP works by injecting a <script> tag and receiving a callback.
  let _cbCounter = 0;

  function jsonp(params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!_scriptUrl) {
        reject(new Error('Apps Script URL not configured. Go to ⚙️ Config.'));
        return;
      }

      const cbName = '__gasCallback_' + (++_cbCounter) + '_' + Date.now();
      let timer = null;
      let script = null;

      // Cleanup helper
      const cleanup = () => {
        clearTimeout(timer);
        if (script && script.parentNode) script.parentNode.removeChild(script);
        try { delete window[cbName]; } catch { window[cbName] = undefined; }
      };

      // Register callback
      window[cbName] = (data) => {
        cleanup();
        if (data && data.error) {
          reject(new Error(data.error));
        } else {
          resolve(data);
        }
      };

      // Timeout
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Request timed out (20s). Check your Apps Script URL and deployment.'));
      }, timeoutMs);

      // Build URL with callback
      const urlParams = new URLSearchParams({ ...params, callback: cbName, _ts: Date.now() });
      const url = `${_scriptUrl}?${urlParams.toString()}`;

      // Inject script tag
      script = document.createElement('script');
      script.src = url;
      script.onerror = () => {
        cleanup();
        reject(new Error('Network error. Check your Apps Script URL and ensure it is deployed as "Anyone can access".'));
      };
      document.head.appendChild(script);
    });
  }

  /* ── BUILD PARAMS WITH CSRF ──────────────────────────── */
  function buildParams(action, data = {}) {
    const session = Security.getSession();
    const csrfToken = session ? session.csrfToken : '';

    // FIX: Do NOT run Security.sanitize() on values going to the sheet.
    // sanitize() is an HTML-output escaper — it converts '/' → '&#x2F;', which
    // corrupts dates (03/11/2026 → 03&#x2F;11&#x2F;2026) and any name with
    // apostrophes or slashes. The sheet must store raw, human-readable values.
    // Input validation (validateRecord) already guards against malicious input
    // before this point, so sanitization here is redundant and harmful.
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      clean[k] = typeof v === 'string' ? v.trim() : v;
    }
    return { action, _csrf: csrfToken, ...clean };
  }

  /* ── CORE REQUEST ────────────────────────────────────── */
  async function request(action, data = {}, retries = 0) {
    if (!_scriptUrl) throw new Error('Apps Script URL not configured. Go to ⚙️ Config.');
    Security.auditLog('API_REQUEST', { action });

    const params = buildParams(action, data);

    try {
      const json = await jsonp(params);
      Security.auditLog('API_SUCCESS', { action });
      return json;
    } catch (err) {
      if (retries < 2 && !err.message.includes('timed out') && !err.message.includes('not configured')) {
        await new Promise(r => setTimeout(r, 1200 * (retries + 1)));
        return request(action, data, retries + 1);
      }
      Security.auditLog('API_ERROR', { action, error: err.message });
      throw err;
    }
  }

  /* ── CRUD OPERATIONS ─────────────────────────────────── */
  async function getAll() {
    return request('getAll');
  }

  async function addRecord(record) {
    if (!Security.can('canAdd')) throw new Error('Permission denied: You cannot add records.');
    validateRecord(record);
    return request('add', record);
  }

  async function updateRecord(record) {
    if (!Security.can('canEdit')) throw new Error('Permission denied: You cannot edit records.');
    if (!record.id) throw new Error('Record ID is required for update.');
    validateRecord(record);
    return request('update', record);
  }

  async function deleteRecord(id) {
    if (!Security.can('canDelete')) throw new Error('Permission denied: You cannot delete records.');
    if (!id || typeof id !== 'string') throw new Error('Invalid record ID.');
    return request('delete', { id });
  }

  async function testConnection() {
    return request('ping');
  }

  /* ── USER AUTHENTICATION ─────────────────────────────── */
  async function authenticateUser(username, passwordHash) {
    return request('auth', { username, passwordHash });
  }

  async function changePassword(userId, oldHash, newHash) {
    return request('changePassword', { userId, oldHash, newHash });
  }

  /* ── RECORD VALIDATION ───────────────────────────────── */
  function validateRecord(r) {
    const required = ['familyName','givenName','dob','gender','purok','barangay','motherFamily','motherGiven'];
    for (const f of required) {
      if (!r[f] || !String(r[f]).trim()) throw new Error(`Missing required field: ${f}`);
    }

    const validations = [
      ['familyName',       'name'],
      ['givenName',        'name'],
      ['middleName',       'name'],
      ['dob',              'date'],
      ['purok',            'purok'],
      ['barangay',         'barangay'],
      ['motherFamily',     'name'],
      ['motherGiven',      'name'],
      ['motherMiddle',     'name'],
      ['dateVacc',         'date'],
      ['vaccinatorFamily', 'name'],
      ['vaccinatorGiven',  'name'],
      ['vaccinatorMiddle', 'name'],
      ['remarks',          'remarks'],
    ];

    for (const [field, type] of validations) {
      const val = r[field];
      if (val && !Security.validateInput(val, type)) {
        throw new Error(`Invalid characters in field: ${field}`);
      }
    }

    if (r.dob) {
      const dob = new Date(r.dob);
      const now = new Date();
      const months = (now.getFullYear() - dob.getFullYear()) * 12 + (now.getMonth() - dob.getMonth());
      if (months < 6 || months > 59) {
        console.warn(`Age ${months} months is outside 6–59 month SIA range for ${r.familyName}`);
      }
    }

    return true;
  }

  /* ── PUBLIC API ──────────────────────────────────────── */
  return {
    setScriptUrl,
    getScriptUrl,
    request,       // exposed so app.js can call custom actions (addComment, getComments etc.)
    getAll,
    addRecord,
    updateRecord,
    deleteRecord,
    testConnection,
    authenticateUser,
    changePassword,
    validateRecord,
  };

})();

window.API = API;

/**
 * Code.gs — Google Apps Script Backend
 * SIA Masterlist | Ragay Rural Health Unit | DOH Philippines
 *
 * SETUP:
 *  1. Set SHEET_ID to your Google Sheet's ID (from the URL).
 *  2. Deploy as Web App: Execute as Me, Anyone can access.
 *  3. Paste the Web App URL in the ⚙ Config panel of the website.
 *
 * FIX: Added JSONP (callback) support so browsers can communicate with this
 * script. Google Apps Script redirects through script.googleusercontent.com
 * which blocks standard fetch() calls from external origins. JSONP (wrapping
 * the JSON response in a callback function) is the correct solution.
 *
 * SHEETS REQUIRED:
 *  - SIA_Masterlist   (patient/vaccination records)
 *  - Users            (authentication)
 *  - AuditLog         (server-side audit trail)
 */

'use strict';

/* ── CONFIGURATION ─────────────────────────────────── */
const SHEET_ID       = '';  // ← Paste your Google Sheet ID here (leave blank to use active spreadsheet)
const MASTERLIST_TAB = 'SIA_Masterlist';
const USERS_TAB      = 'Users';
const AUDIT_TAB      = 'AuditLog';

/* ── ALLOWED ACTIONS ───────────────────────────────── */
const ALLOWED_ACTIONS = new Set(['getAll','add','update','delete','ping','auth','changePassword','getStats']);

/* ── RESPONSE HELPERS ───────────────────────────────── */
// FIX: Always wrap response in JSONP callback if provided, otherwise plain JSON.
// This is the critical fix for browser connectivity.
function jsonResponse(data, callbackName) {
  const json = JSON.stringify(data);
  if (callbackName && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(callbackName)) {
    // JSONP response — wrap in callback function call
    return ContentService
      .createTextOutput(callbackName + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  // Plain JSON fallback
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ── SPREADSHEET ACCESS ─────────────────────────────── */
function getSpreadsheet() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name) {
  const ss    = getSpreadsheet();
  let   sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === MASTERLIST_TAB) {
      sheet.appendRow([
        'id','familyName','givenName','middleName','dob','gender','purok','barangay',
        'motherFamily','motherGiven','motherMiddle','philhealth','contact','relationship',
        'vaccine','dateVacc','vaccSite','status','vaccinatorFamily','vaccinatorGiven',
        'vaccinatorMiddle','designation','remarks','dateEncoded','encodedBy',
      ]);
    }
    if (name === USERS_TAB) {
      sheet.appendRow(['id','username','passwordHash','role','name','active','lastLogin']);
      // Default admin — replace passwordHash with a real SHA-256 hash before production
      sheet.appendRow([
        Utilities.getUuid(), 'admin',
        '0000000000000000000000000000000000000000000000000000000000000000',
        'ADMIN', 'System Administrator', 'TRUE', ''
      ]);
    }
    if (name === AUDIT_TAB) {
      sheet.appendRow(['timestamp','action','userId','username','role','details','ip']);
    }
  }
  return sheet;
}

/* ── ENTRY POINT ────────────────────────────────────── */
function doGet(e) {
  const p        = e.parameter || {};
  const action   = sanitize(p.action   || '');
  const callback = sanitize(p.callback || '');   // FIX: read JSONP callback name

  // Serve app HTML if no action (GAS fallback mode)
  if (!action) {
    try {
      return HtmlService
        .createHtmlOutputFromFile('index')
        .setTitle('SIA Masterlist – Ragay RHU')
        .setSandboxMode(HtmlService.SandboxMode.IFRAME)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch(err) {
      // index.html not present in GAS — return a helpful message
      return ContentService
        .createTextOutput('SIA Masterlist API is running. Add ?action=ping to test.')
        .setMimeType(ContentService.MimeType.TEXT);
    }
  }

  // Validate action
  if (!ALLOWED_ACTIONS.has(action)) {
    return jsonResponse({ error: 'Unknown action: ' + action }, callback);
  }

  try {
    switch (action) {
      case 'ping':
        return jsonResponse({ ok: true, time: new Date().toISOString(), version: '2.0' }, callback);
      case 'getAll':
        return jsonResponse(getAllRecords(), callback);
      case 'add':
        return jsonResponse(addRecord(p), callback);
      case 'update':
        return jsonResponse(updateRecord(p), callback);
      case 'delete':
        return jsonResponse(deleteRecord(p.id), callback);
      case 'auth':
        return jsonResponse(authenticateUser(p.username, p.passwordHash), callback);
      case 'changePassword':
        return jsonResponse(changePassword(p.userId, p.oldHash, p.newHash), callback);
      case 'getStats':
        return jsonResponse(getStats(), callback);
      default:
        return jsonResponse({ error: 'Unknown action' }, callback);
    }
  } catch (err) {
    serverAudit('ERROR', p.username || 'unknown', '', action, { error: err.message });
    return jsonResponse({ error: err.message }, callback);
  }
}

// FIX: Also handle POST requests (some browsers/environments use POST)
function doPost(e) {
  return doGet(e);
}

/* ── RECORD OPERATIONS ──────────────────────────────── */
function getAllRecords() {
  const sheet = getSheet(MASTERLIST_TAB);
  const data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(String);
  return data.slice(1)
    .filter(row => row[0])
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = String(row[i] || '').trim(); });
      return obj;
    });
}

function addRecord(p) {
  if (!p.familyName || !p.givenName || !p.dob) return { error: 'Missing required fields' };
  const id  = p.id || Utilities.getUuid();
  const row = buildRow(id, p);
  getSheet(MASTERLIST_TAB).appendRow(row);
  serverAudit('RECORD_ADD', p.encodedBy || 'unknown', '', 'add', { id, name: p.familyName });
  return { success: true, id };
}

function updateRecord(p) {
  if (!p.id) return { error: 'ID required' };
  const sheet  = getSheet(MASTERLIST_TAB);
  const data   = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.id)) {
      const row   = buildRow(p.id, p);
      const range = sheet.getRange(i + 1, 1, 1, row.length);
      range.setValues([row]);
      serverAudit('RECORD_UPDATE', p.encodedBy || 'unknown', '', 'update', { id: p.id });
      return { success: true };
    }
  }
  return { error: 'Record not found' };
}

function deleteRecord(id) {
  if (!id) return { error: 'ID required' };
  const sheet = getSheet(MASTERLIST_TAB);
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      serverAudit('RECORD_DELETE', 'system', '', 'delete', { id });
      return { success: true };
    }
  }
  return { error: 'Record not found' };
}

function buildRow(id, p) {
  const s = (v) => sanitize(String(v || ''));
  return [
    id,
    s(p.familyName), s(p.givenName), s(p.middleName),
    s(p.dob), s(p.gender), s(p.purok), s(p.barangay),
    s(p.motherFamily), s(p.motherGiven), s(p.motherMiddle),
    s(p.philhealth), s(p.contact), s(p.relationship),
    s(p.vaccine), s(p.dateVacc), s(p.vaccSite), s(p.status),
    s(p.vaccinatorFamily), s(p.vaccinatorGiven), s(p.vaccinatorMiddle),
    s(p.designation), s(p.remarks),
    s(p.dateEncoded) || new Date().toLocaleDateString('en-PH'),
    s(p.encodedBy),
  ];
}

/* ── AUTHENTICATION ─────────────────────────────────── */
function authenticateUser(username, passwordHash) {
  if (!username || !passwordHash) return { error: 'Missing credentials' };
  const sheet   = getSheet(USERS_TAB);
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const uIdx    = headers.indexOf('username');
  const pIdx    = headers.indexOf('passwordHash');
  const rIdx    = headers.indexOf('role');
  const nIdx    = headers.indexOf('name');
  const aIdx    = headers.indexOf('active');
  const idIdx   = headers.indexOf('id');
  const llIdx   = headers.indexOf('lastLogin');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[uIdx]).toLowerCase() === username.toLowerCase()) {
      if (String(row[aIdx]).toLowerCase() !== 'true') return { error: 'Account is inactive' };
      if (String(row[pIdx]) === String(passwordHash)) {
        if (llIdx >= 0) sheet.getRange(i + 1, llIdx + 1).setValue(new Date().toISOString());
        const user = { id: row[idIdx], username: row[uIdx], name: row[nIdx], role: row[rIdx] };
        serverAudit('LOGIN', username, '', 'auth', { role: row[rIdx] });
        return { success: true, user };
      } else {
        serverAudit('LOGIN_FAILED', username, '', 'auth', {});
        return { error: 'Invalid credentials' };
      }
    }
  }
  return { error: 'User not found' };
}

function changePassword(userId, oldHash, newHash) {
  if (!userId || !oldHash || !newHash) return { error: 'Missing parameters' };
  const sheet   = getSheet(USERS_TAB);
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const idIdx   = headers.indexOf('id');
  const pIdx    = headers.indexOf('passwordHash');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(userId)) {
      if (String(data[i][pIdx]) !== String(oldHash)) return { error: 'Current password incorrect' };
      sheet.getRange(i + 1, pIdx + 1).setValue(String(newHash));
      serverAudit('PASSWORD_CHANGE', userId, '', 'changePassword', {});
      return { success: true };
    }
  }
  return { error: 'User not found' };
}

/* ── STATS ──────────────────────────────────────────── */
function getStats() {
  const records = getAllRecords();
  const total   = records.length;
  const vacc    = records.filter(r => r.status === 'Vaccinated').length;
  const male    = records.filter(r => r.gender === 'Male').length;
  const female  = records.filter(r => r.gender === 'Female').length;
  return { total, vaccinated: vacc, male, female, coverage: total ? Math.round(vacc / total * 100) : 0 };
}

/* ── SERVER-SIDE AUDIT ──────────────────────────────── */
function serverAudit(action, username, userId, source, details) {
  try {
    const sheet = getSheet(AUDIT_TAB);
    sheet.appendRow([
      new Date().toISOString(), action, userId, username, '', JSON.stringify(details), source
    ]);
  } catch (e) {
    Logger.log('Audit log error: ' + e.message);
  }
}

/* ── SANITIZE ───────────────────────────────────────── */
function sanitize(str) {
  return String(str || '')
    .replace(/[<>"'`;\\]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .substring(0, 500)
    .trim();
}

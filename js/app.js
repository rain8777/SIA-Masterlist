/**
 * app.js — SIA Masterlist Main Application Logic
 * Ragay Rural Health Unit | DOH Philippines
 */

'use strict';

const App = (() => {

  /* ── STATE ──────────────────────────────────────────── */
  let allRecords   = [];
  let filteredRecs = [];
  let editingId    = null;
  let currentPage  = 1;
  let sortField    = 'familyName';
  let sortDir      = 'asc';
  const PAGE_SIZE  = 25;
  const CACHE_KEY  = 'sia_records_cache';  // sessionStorage key — cleared on tab/session close

  /* ── CACHE HELPERS ───────────────────────────────────── */
  // FIX #2: Use sessionStorage instead of localStorage.
  // Patient health records (names, DOB, addresses, PhilHealth, vaccination status)
  // must NOT persist across browser sessions. sessionStorage is automatically wiped
  // when the tab or browser is closed, and is not shared across tabs.
  // This complies with RA 10173 (Data Privacy Act) and the policy in security.js.
  function saveCache(records) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(records));
    } catch (e) {
      console.warn('Cache save failed:', e.message);
    }
  }

  function loadCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const records = JSON.parse(raw);
      return Array.isArray(records) ? records : null;
    } catch { return null; }
  }

  function clearCache() {
    sessionStorage.removeItem(CACHE_KEY);
  }

  /* ── INIT ────────────────────────────────────────────── */
  function init() {
    if (!Security.requireAuth()) return;
    Security.startInactivityMonitor();
    AppConfig.init();

    // Reset state for this user login (important in GAS single-page mode)
    allRecords   = [];
    filteredRecs = [];
    currentPage  = 1;

    renderHeader();
    populateFormDropdowns();
    applyRBACToUI();
    bindEvents();

    // Show session user info
    const s = Security.getSession();
    if (s) {
      const role = Security.ROLES[s.role]?.label || s.role;
      const connected = AppConfig.get('scriptUrl') ? '🟢 Connected' : '🔴 No Sheet';
      document.getElementById('sessionUser').textContent = s.name + ' (' + connected + ')';
      document.getElementById('sessionRole').textContent = role;
    }

    // Try to restore cached records for THIS user
    const cached = loadCache();
    if (cached && cached.length > 0) {
      // Filter out any blank records that may have been cached previously
      allRecords = cached.filter(r => r && (String(r.familyName||'').trim() || String(r.givenName||'').trim()));
      populateBarangayFilter();
      applyFilters();
      updateStats();
      renderSummary();
      showToast('📋 ' + cached.length + ' records loaded from cache.', '');
    } else {
      applyFilters();
      updateStats();
    }

    // Always try to sync if sheet URL is configured
    if (AppConfig.get('scriptUrl')) {
      loadFromSheets();
    }

    // Start the login duration clock
    startLoginClock();

    Security.auditLog('PAGE_LOAD', { page: 'dashboard' });
  }

  /* ── HEADER ──────────────────────────────────────────── */
  function renderHeader() {
    const memoEl = document.getElementById('memoDisplay');
    if (memoEl) memoEl.textContent = AppConfig.get('memo', 'DOH-EPI MEMO');
    const campEl = document.getElementById('campaignDisplay');
    if (campEl) campEl.textContent = AppConfig.get('campaign', 'SIA Campaign');
    const periodEl = document.getElementById('periodDisplay');
    if (periodEl) periodEl.textContent = AppConfig.get('period', '');
  }

  /* ── RBAC UI ─────────────────────────────────────────── */
  function applyRBACToUI() {
    const isAdmin = Security.getSession()?.role === 'ADMIN';
    document.querySelectorAll('[data-permission]').forEach(el => {
      const perm = el.dataset.permission;
      if (!Security.can(perm)) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    });
    // Admin-only elements (config, audit, setup guide)
    document.querySelectorAll('[data-admin-only]').forEach(el => {
      if (!isAdmin) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      } else {
        el.style.display = '';
        el.removeAttribute('aria-hidden');
      }
    });
  }

  /* ── FORM DROPDOWNS ──────────────────────────────────── */
  function populateFormDropdowns() {
    // Barangay datalist
    const dl = document.getElementById('barangayList');
    if (dl) {
      dl.innerHTML = AppConfig.BARANGAYS.map(b => `<option value="${Security.sanitize(b)}">`).join('');
    }

    // Vaccine select
    const vSel = document.getElementById('f_vaccine');
    if (vSel) {
      vSel.innerHTML = '<option value="">Select vaccine…</option>' +
        AppConfig.VACCINES.map(g =>
          `<optgroup label="${Security.sanitize(g.group)}">${
            g.items.map(v => `<option value="${Security.sanitize(v.code)}">${Security.sanitize(v.label)}</option>`).join('')
          }</optgroup>`
        ).join('');
    }

    // Designation select
    const dSel = document.getElementById('f_designation');
    if (dSel) {
      dSel.innerHTML = '<option value="">Select…</option>' +
        AppConfig.DESIGNATIONS.map(d => `<option value="${Security.sanitize(d)}">${Security.sanitize(d)}</option>`).join('');
    }

    // Vaccination site
    const sSel = document.getElementById('f_vaccSite');
    if (sSel) {
      sSel.innerHTML = AppConfig.VACCINATION_SITES.map(s => `<option value="${Security.sanitize(s)}">${Security.sanitize(s)}</option>`).join('');
    }
  }

  /* ── EVENTS ──────────────────────────────────────────── */
  function bindEvents() {
    // Search
    document.getElementById('searchBox')?.addEventListener('input', debounce(applyFilters, 250));
    // Filters
    ['filterBarangay','filterGender','filterStatus','filterVaccine'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', applyFilters);
    });
    // Modal close on overlay click
    document.getElementById('modalOverlay')?.addEventListener('click', e => {
      if (e.target.id === 'modalOverlay') closeModal();
    });
    // Close on Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
      if ((e.ctrlKey || e.metaKey) && e.key === 'n' && Security.can('canAdd')) { e.preventDefault(); openModal(); }
    });
    // DOB change → age calc
    document.getElementById('f_dob')?.addEventListener('change', calcAge);
    // Date vaccination auto-today
    document.getElementById('f_vaccine')?.addEventListener('change', e => {
      if (e.target.value && !document.getElementById('f_dateVacc').value) {
        document.getElementById('f_dateVacc').value = new Date().toISOString().split('T')[0];
        document.getElementById('f_status').value = 'Vaccinated';
      }
    });
  }

  /* ── LOAD FROM SHEETS ────────────────────────────────── */
  async function loadFromSheets() {
    if (!Security.requireAuth()) return;
    const url = AppConfig.get('scriptUrl');
    if (!url) { showToast('⚙️ Configure your Apps Script URL first!', 'error'); openConfigPanel(); return; }
    showToast('Syncing from Google Sheets…');
    setBtnLoading('btnSync', true, '🔄 Syncing…');

    try {
      const data = await API.getAll();
      if (!Array.isArray(data)) throw new Error('Invalid response from server');

      // Declare valid at the top of try so it is always in scope
      let valid = [];

      if (data.length === 0) {
        // Sheet is genuinely empty — clear everything
        allRecords = [];
        saveCache([]);
      } else {
        // Keep records that have at least familyName or givenName (the Code.gs
        // HEADER_MAP normalises column headers, so these keys should always exist).
        // Fallback: also accept any record with ANY non-empty non-metadata field
        // in case an unmapped header slipped through.
        valid = data.filter(r => {
          if (!r) return false;
          if (String(r.familyName || '').trim()) return true;
          if (String(r.givenName  || '').trim()) return true;
          // Fallback — accept if at least one substantive field has a value
          return Object.entries(r).some(([k, v]) =>
            k !== 'id' && k !== 'dateEncoded' && k !== 'encodedBy' && String(v || '').trim()
          );
        });

        if (valid.length > 0) {
          allRecords = valid.map(sanitizeRecord);
          saveCache(allRecords);
        } else {
          // All rows came back but every one was empty after mapping.
          // Log the raw keys so the developer can see what the sheet returned.
          const sampleKeys = data[0] ? Object.keys(data[0]) : [];
          console.error('Sync: received', data.length, 'rows but all were empty after mapping.');
          console.error('Sample record keys from server:', sampleKeys);
          console.error('Sample record values:', data[0]);
          showToast(`⚠️ Sync got ${data.length} rows but all were empty. Open browser console (F12) and check the "Sample record keys" log to diagnose the sheet headers.`, 'error');
          return;
        }
      }

      // Refresh UI
      populateBarangayFilter();
      applyFilters();
      updateStats();
      renderSummary();

      const loaded  = valid.length;
      const skipped = data.length - loaded;
      const msg = skipped > 0
        ? `✅ Synced! ${loaded} records loaded. (${skipped} blank rows skipped)`
        : `✅ Synced! ${loaded} records loaded.`;
      showToast(msg, 'success');
      Security.auditLog('SYNC_SUCCESS', { count: loaded });

    } catch (e) {
      // On error restore from cache so existing data is not lost
      const cached = loadCache();
      if (cached && cached.length > 0 && allRecords.length === 0) {
        allRecords = cached;
        populateBarangayFilter();
        applyFilters();
        updateStats();
        renderSummary();
      }
      showToast(`❌ Sync failed: ${e.message}`, 'error');
      Security.auditLog('SYNC_ERROR', { error: e.message });
    } finally {
      setBtnLoading('btnSync', false, '🔄 Sync Sheets');
    }
  }

  function sanitizeRecord(r) {
    // Do NOT run Security.sanitize() here — it HTML-encodes '/' which corrupts dates.
    // FIX: Also decode any &#x2F; / &amp; / &#x27; etc. that were previously written
    // to the sheet by the old buildParams() bug, so corrupted records heal on next sync.
    const htmlDecode = (s) => s
      .replace(/&#x2F;/gi, '/')
      .replace(/&#x27;/gi, "'")
      .replace(/&#x3D;/gi, '=')
      .replace(/&#x60;/gi, '`')
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi,  '&')
      .replace(/&lt;/gi,   '<')
      .replace(/&gt;/gi,   '>');
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      clean[k] = typeof v === 'string' ? htmlDecode(v.trim()) : (v ?? '');
    }
    return clean;
  }

  /* ── FILTER & SORT ───────────────────────────────────── */
  function applyFilters() {
    const q  = (document.getElementById('searchBox')?.value || '').toLowerCase();
    const bn = document.getElementById('filterBarangay')?.value || '';
    const gn = document.getElementById('filterGender')?.value   || '';
    const st = document.getElementById('filterStatus')?.value   || '';
    const vc = document.getElementById('filterVaccine')?.value  || '';

    filteredRecs = allRecords.filter(r => {
      const fullName = `${r.familyName} ${r.givenName} ${r.middleName}`.toLowerCase();
      const motherN  = `${r.motherFamily} ${r.motherGiven} ${r.motherMiddle}`.toLowerCase();
      const addr     = `${r.purok} ${r.barangay}`.toLowerCase();
      return (!q  || fullName.includes(q) || motherN.includes(q) || addr.includes(q))
          && (!bn || r.barangay === bn)
          && (!gn || r.gender === gn)
          && (!st || r.status === st)
          && (!vc || r.vaccine === vc);
    });

    filteredRecs.sort((a, b) => {
      let va, vb;
      // FIX #6: 'age' is computed from dob — there is no 'age' field on records.
      // Sort by calculated months so the Age column header actually works.
      if (sortField === 'age') {
        va = calcAgeMonths(a.dob) ?? 999;
        vb = calcAgeMonths(b.dob) ?? 999;
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ?  1 : -1;
        return 0;
      }
      va = a[sortField] || ''; vb = b[sortField] || '';
      if (sortField === 'dob' || sortField === 'dateVacc') {
        // Handle MM/DD/YYYY format for sorting
        const parseSortDate = (s) => {
          const m = String(s||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          return m ? new Date(m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0')) : new Date(s||'');
        };
        va = parseSortDate(va); vb = parseSortDate(vb);
      }
      else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });

    currentPage = 1;
    renderTable();
    updateStats();
  }

  window.sortBy = function(field) {
    if (sortField === field) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortField = field; sortDir = 'asc'; }
    applyFilters();
  };

  function populateBarangayFilter() {
    const sel = document.getElementById('filterBarangay');
    if (!sel) return;
    const bns = [...new Set(allRecords.map(r => r.barangay).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All Barangays</option>' +
      bns.map(b => `<option value="${Security.sanitize(b)}">${Security.sanitize(b)}</option>`).join('');
  }

  /* ── TABLE RENDER ────────────────────────────────────── */
  function renderTable() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const q     = document.getElementById('searchBox')?.value || '';
    const start = (currentPage - 1) * PAGE_SIZE;
    const end   = Math.min(start + PAGE_SIZE, filteredRecs.length);
    const page  = filteredRecs.slice(start, end);

    if (!page.length) {
      tbody.innerHTML = `<tr><td colspan="20"><div class="empty-state"><div class="empty-icon">💉</div><p>${allRecords.length ? 'No records match your filters.' : 'No records yet. Add a child or sync from Google Sheets.'}</p></div></td></tr>`;
    } else {
      tbody.innerHTML = page.map((r, i) => buildRow(r, start + i + 1, q)).join('');
    }

    renderPagination();
  }

  function buildRow(r, num, q) {
    const age    = calcAgeMonths(r.dob);
    const ageTxt = age !== null ? (age < 12 ? `${age}mo` : `${Math.floor(age/12)}y ${age%12}mo`) : '—';
    const sClass = { 'Vaccinated':'vacc','Not Vaccinated':'unvacc','Refused':'partial','Absent':'partial' }[r.status] || 'partial';
    const h      = t => q ? highlight(Security.sanitize(t||''), q) : Security.sanitize(t||'');
    const canE   = Security.can('canEdit');
    const canD   = Security.can('canDelete');

    return `<tr role="row">
      <td class="td-num">${num}</td>
      <td class="td-name"><span class="family">${h(r.familyName)}</span></td>
      <td>${h(r.givenName)}</td>
      <td>${h(r.middleName)}</td>
      <td class="td-dob">${fmtDate(r.dob)}</td>
      <td class="td-age">${ageTxt}</td>
      <td><span class="badge badge-${Security.sanitize((r.gender||'').toLowerCase())}">${Security.sanitize(r.gender||'—')}</span></td>
      <td>${h(r.purok)}</td>
      <td>${h(r.barangay)}</td>
      <td><span class="family">${h(r.motherFamily)}</span></td>
      <td>${h(r.motherGiven)}</td>
      <td>${h(r.motherMiddle)}</td>
      <td><strong>${Security.sanitize(r.vaccine||'—')}</strong></td>
      <td class="td-dob">${fmtDate(r.dateVacc)}</td>
      <td><span class="family">${h(r.vaccinatorFamily)}</span></td>
      <td>${h(r.vaccinatorGiven)}</td>
      <td>${h(r.vaccinatorMiddle)}</td>
      <td><span class="badge badge-${sClass}">${Security.sanitize(r.status||'—')}</span></td>
      <td class="td-remarks">${h(r.remarks)}</td>
      <td class="td-actions">
        ${canE ? `<button class="btn btn-outline btn-sm" onclick="App.editRecord('${Security.sanitize(r.id||'')}')">✏</button>` : ''}
        ${canD ? `<button class="btn btn-danger btn-sm" onclick="App.deleteRecord('${Security.sanitize(r.id||'')}')">🗑</button>` : ''}
        ${!canE && !canD ? '<span class="muted-sm">View only</span>' : ''}
      </td>
    </tr>`;
  }

  /* ── PAGINATION ──────────────────────────────────────── */
  function renderPagination() {
    const total = filteredRecs.length;
    const pages = Math.ceil(total / PAGE_SIZE);
    const start = total ? (currentPage - 1) * PAGE_SIZE + 1 : 0;
    const end   = Math.min(currentPage * PAGE_SIZE, total);
    const info  = document.getElementById('pageInfo');
    const btns  = document.getElementById('pageBtns');
    if (info) info.textContent = `Showing ${start}–${end} of ${total} records`;
    if (!btns) return;
    btns.innerHTML = '';
    const add = (lbl, p, active) => {
      const b = document.createElement('button');
      b.className = 'page-btn' + (active ? ' active' : '');
      b.textContent = lbl;
      b.setAttribute('aria-label', `Page ${p}`);
      b.onclick = () => { currentPage = p; renderTable(); };
      btns.appendChild(b);
    };
    if (currentPage > 1) add('‹', currentPage - 1, false);
    for (let i = Math.max(1, currentPage - 2); i <= Math.min(pages, currentPage + 2); i++) add(i, i, i === currentPage);
    if (currentPage < pages) add('›', currentPage + 1, false);
  }

  /* ── STATS ───────────────────────────────────────────── */
  function updateStats() {
    const total   = allRecords.length;
    const males   = allRecords.filter(r => r.gender === 'Male').length;
    const femals  = allRecords.filter(r => r.gender === 'Female').length;
    const vacc    = allRecords.filter(r => r.status === 'Vaccinated').length;
    // FIX #4: Count all non-vaccinated (Not Vaccinated + Refused + Absent + Deferred)
    const notVacc = allRecords.filter(r => r.status && r.status !== 'Vaccinated').length;
    const pct     = total ? Math.round(vacc / total * 100) : 0;
    setText('statTotal',    total);
    setText('statMale',     males);
    setText('statFemale',   femals);
    setText('statVacc',     vacc);
    setText('statNotVacc',  notVacc);
    setText('statCoverage', pct + '%');
  }

  /* ── SUMMARY ─────────────────────────────────────────── */
  function renderSummary() {
    const bMap = {};
    allRecords.forEach(r => {
      const b = r.barangay || '(Unknown)';
      if (!bMap[b]) bMap[b] = { total: 0, vacc: 0, refused: 0, absent: 0, deferred: 0, male: 0, female: 0 };
      bMap[b].total++;
      if (r.status === 'Vaccinated')    bMap[b].vacc++;
      if (r.status === 'Refused')       bMap[b].refused++;
      if (r.status === 'Absent')        bMap[b].absent++;
      if (r.status === 'Deferred')      bMap[b].deferred++;
      if (r.gender === 'Male')          bMap[b].male++;
      if (r.gender === 'Female')        bMap[b].female++;
    });

    const bEl = document.getElementById('summaryBarangay');
    if (bEl) bEl.innerHTML = Object.entries(bMap)
      .sort((a,b) => a[0].localeCompare(b[0]))
      .map(([b, d]) => {
        const pct = d.total ? Math.round(d.vacc/d.total*100) : 0;
        const bar = `<div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>`;
        return `<tr>
          <td>${Security.sanitize(b)}</td>
          <td style="text-align:center;">${d.total}</td>
          <td style="text-align:center;color:var(--success);font-weight:600;">${d.vacc}</td>
          <td style="text-align:center;color:var(--danger);">${d.refused}</td>
          <td style="text-align:center;color:var(--warn);">${d.absent}</td>
          <td style="text-align:center;color:var(--muted);">${d.deferred}</td>
          <td>${bar} ${pct}%</td>
        </tr>`;
      }).join('') || noData(7);

    const vMap = {};
    allRecords.filter(r => r.vaccine).forEach(r => { vMap[r.vaccine] = (vMap[r.vaccine]||0)+1; });
    const vEl = document.getElementById('summaryVaccines');
    if (vEl) vEl.innerHTML = Object.entries(vMap).sort((a,b) => b[1]-a[1])
      .map(([v,c]) => `<tr><td><strong>${Security.sanitize(v)}</strong></td><td style="text-align:center;">${c}</td></tr>`).join('') || noData(2);

    const groups = { '6–11 mo':0,'12–23 mo':0,'24–35 mo':0,'36–47 mo':0,'48–59 mo':0 };
    allRecords.forEach(r => {
      const m = calcAgeMonths(r.dob);
      if (m>=6&&m<=11)  groups['6–11 mo']++;
      else if(m>=12&&m<=23) groups['12–23 mo']++;
      else if(m>=24&&m<=35) groups['24–35 mo']++;
      else if(m>=36&&m<=47) groups['36–47 mo']++;
      else if(m>=48&&m<=59) groups['48–59 mo']++;
    });
    const aEl = document.getElementById('summaryAgeGroup');
    if (aEl) aEl.innerHTML = Object.entries(groups)
      .map(([g,c]) => `<tr><td>${g}</td><td style="text-align:center;">${c}</td></tr>`).join('');

    // Status breakdown
    const total    = allRecords.length;
    const vacc     = allRecords.filter(r => r.status === 'Vaccinated').length;
    const refused  = allRecords.filter(r => r.status === 'Refused').length;
    const absent   = allRecords.filter(r => r.status === 'Absent').length;
    const deferred = allRecords.filter(r => r.status === 'Deferred').length;
    const notVacc  = allRecords.filter(r => r.status === 'Not Vaccinated').length;
    const sEl = document.getElementById('summaryStatus');
    if (sEl) sEl.innerHTML = [
      ['Vaccinated',    vacc,     'var(--success)', '#DCFCE7'],
      ['Not Vaccinated',notVacc,  'var(--danger)',  '#FEE2E2'],
      ['Refused',       refused,  'var(--danger)',  '#FEE2E2'],
      ['Absent',        absent,   'var(--warn)',    '#FEF9C3'],
      ['Deferred',      deferred, 'var(--muted)',   '#F0F4F8'],
    ].map(([label, count, color, bg]) => {
      const pct = total ? Math.round(count/total*100) : 0;
      const bar = `<div class="prog-bar" style="width:80px;"><div class="prog-fill" style="width:${pct}%;background:${color};"></div></div>`;
      return `<tr>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px;"></span>${label}</td>
        <td style="text-align:center;font-weight:700;color:${color};">${count}</td>
        <td>${bar} <span style="font-size:11px;color:var(--muted);">${pct}%</span></td>
      </tr>`;
    }).join('');
  }

  /* ── MODAL ───────────────────────────────────────────── */
  function openModal(record) {
    if (!Security.requireAuth()) return;
    if (!record && !Security.can('canAdd')) { showToast('Permission denied.', 'error'); return; }
    if (record && !Security.can('canEdit')) { showToast('Permission denied.', 'error'); return; }

    editingId = record ? record.id : null;
    document.getElementById('modalTitle').textContent = record ? '✏️ Edit Record' : '➕ Add Child';

    const fields = ['familyName','givenName','middleName','dob','gender','purok','barangay',
      'motherFamily','motherGiven','motherMiddle','philhealth','contact','relationship',
      'vaccine','dateVacc','status','vaccinatorFamily','vaccinatorGiven','vaccinatorMiddle',
      'designation','vaccSite','remarks'];
    fields.forEach(f => {
      const el = document.getElementById('f_' + f);
      if (el) el.value = record ? (record[f] || '') : (f === 'status' ? 'Vaccinated' : '');
    });

    if (!record) {
      // Default date vaccinated = today
      const dv = document.getElementById('f_dateVacc');
      if (dv && !dv.value) dv.value = new Date().toISOString().split('T')[0];
    }

    calcAge();
    document.getElementById('modalOverlay').classList.add('open');
    document.getElementById('f_familyName')?.focus();

    // Generate new CSRF for this form session
    document.getElementById('formCsrfToken').value = Security.getSession()?.csrfToken || '';
  }

  function closeModal() {
    document.getElementById('modalOverlay')?.classList.remove('open');
    editingId = null;
  }

  async function saveRecord() {
    if (!Security.requireAuth()) return;
    const csrfEl = document.getElementById('formCsrfToken');
    if (!Security.validateCSRF(csrfEl?.value)) { showToast('⚠ Security token mismatch. Refresh and try again.', 'error'); return; }

    const required = [
      ['f_familyName','Family Name'], ['f_givenName','Given Name'], ['f_dob','Date of Birth'],
      ['f_gender','Sex'], ['f_purok','Purok/Sitio'], ['f_barangay','Barangay'],
      ['f_motherFamily','Mother Family Name'], ['f_motherGiven','Mother Given Name'],
    ];
    for (const [id, label] of required) {
      if (!document.getElementById(id)?.value.trim()) {
        showToast(`⚠ ${label} is required.`, 'error');
        document.getElementById(id)?.focus();
        return;
      }
    }

    const data = {
      id:               editingId || crypto.randomUUID(),
      familyName:       getVal('f_familyName').toUpperCase(),
      givenName:        getVal('f_givenName'),
      middleName:       getVal('f_middleName'),
      dob:              getVal('f_dob'),
      gender:           getVal('f_gender'),
      purok:            getVal('f_purok'),
      barangay:         getVal('f_barangay'),
      motherFamily:     getVal('f_motherFamily').toUpperCase(),
      motherGiven:      getVal('f_motherGiven'),
      motherMiddle:     getVal('f_motherMiddle'),
      philhealth:       getVal('f_philhealth'),
      contact:          getVal('f_contact'),
      relationship:     getVal('f_relationship'),
      vaccine:          getVal('f_vaccine'),
      dateVacc:         getVal('f_dateVacc'),
      status:           getVal('f_status'),
      vaccinatorFamily: getVal('f_vaccinatorFamily').toUpperCase(),
      vaccinatorGiven:  getVal('f_vaccinatorGiven'),
      vaccinatorMiddle: getVal('f_vaccinatorMiddle'),
      designation:      getVal('f_designation'),
      vaccSite:         getVal('f_vaccSite'),
      remarks:          getVal('f_remarks'),
      dateEncoded:      fmtDate(new Date().toISOString().split('T')[0]),
      encodedBy:        Security.getSession()?.username || '',
    };

    setBtnLoading('saveBtn', true, 'Saving…');

    // FIX #5: Track whether we've already pushed locally so the catch block
    // doesn't push a second copy if the API call partially executed before throwing.
    let pushedLocally = false;

    try {
      if (editingId) {
        await API.updateRecord(data);
        const idx = allRecords.findIndex(r => r.id === editingId);
        if (idx > -1) allRecords[idx] = data; else allRecords.push(data);
        saveCache(allRecords);  // update cache
        Security.auditLog('RECORD_UPDATED', { id: editingId, name: data.familyName });
      } else {
        const result = await API.addRecord(data);
        if (result?.id) data.id = result.id;
        allRecords.push(data);
        pushedLocally = true;
        saveCache(allRecords);  // update cache
        Security.auditLog('RECORD_ADDED', { id: data.id, name: data.familyName });
      }
      populateBarangayFilter();
      applyFilters();
      updateStats();
      renderSummary();
      closeModal();
      showToast(editingId ? '✅ Record updated!' : '✅ Record added!', 'success');
    } catch (e) {
      // Save locally even if sheet fails — but only if not already pushed above
      if (!editingId && !pushedLocally) allRecords.push(data);
      applyFilters(); updateStats();
      showToast(`⚠ Saved locally. Sheet sync failed: ${e.message}`, 'error');
      Security.auditLog('RECORD_SAVE_ERROR', { error: e.message });
    } finally {
      setBtnLoading('saveBtn', false, '💾 Save Record');
    }
  }

  function editRecord(id) {
    const r = allRecords.find(r => r.id === id);
    if (r) openModal(r);
  }

  async function deleteRecord(id) {
    if (!Security.can('canDelete')) { showToast('Permission denied.', 'error'); return; }
    if (!confirm('Permanently delete this record? This action is logged and cannot be undone.')) return;
    const r = allRecords.find(r => r.id === id);
    allRecords = allRecords.filter(r => r.id !== id);
    saveCache(allRecords);  // update cache
    applyFilters(); updateStats(); renderSummary();
    try {
      await API.deleteRecord(id);
      Security.auditLog('RECORD_DELETED', { id, name: r?.familyName });
      showToast('🗑 Record deleted.', 'success');
    } catch (e) {
      showToast(`⚠ Local delete done, sheet sync failed: ${e.message}`, 'error');
    }
  }

  /* ── EXPORT CSV ──────────────────────────────────────── */
  function exportCSV() {
    if (!Security.can('canExport')) { showToast('Permission denied.', 'error'); return; }
    Security.auditLog('EXPORT_CSV', { count: filteredRecs.length });

    const headers = [
      'No.','Family Name','Given Name','Middle Name','Date of Birth','Age (months)',
      'Sex','Purok/Sitio/Street','Barangay','Mother Family Name','Mother Given Name',
      'Mother Middle Name','PhilHealth No.','Contact No.','Relationship',
      'Vaccine Given','Date Vaccinated','Vaccination Site','Vaccinator Family',
      'Vaccinator Given','Vaccinator Middle','Designation','Status','Remarks','Date Encoded','Encoded By',
    ];
    const csvRows = filteredRecs.map((r,i) => [
      i+1, r.familyName, r.givenName, r.middleName, fmtDate(r.dob), calcAgeMonths(r.dob)||'',
      r.gender, r.purok, r.barangay, r.motherFamily, r.motherGiven, r.motherMiddle,
      r.philhealth, r.contact, r.relationship,
      r.vaccine, fmtDate(r.dateVacc), r.vaccSite,
      r.vaccinatorFamily, r.vaccinatorGiven, r.vaccinatorMiddle, r.designation,
      r.status, r.remarks, r.dateEncoded, r.encodedBy,
    ].map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(','));

    const csv  = [headers.join(','), ...csvRows].join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `SIA_Masterlist_Ragay_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('⬇ CSV exported!', 'success');
  }

  /* ── AGE CALC ────────────────────────────────────────── */
  function calcAge() {
    const dob = document.getElementById('f_dob')?.value;
    const el  = document.getElementById('ageDisplay');
    if (!el) return;
    if (!dob) { el.style.display = 'none'; return; }
    const m = calcAgeMonths(dob);
    if (m === null) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (m < 6 || m > 59) {
      el.className = 'age-display age-warn';
      el.textContent = `⚠ Age: ${m}mo — Outside 6–59 month SIA target range`;
    } else {
      el.className = 'age-display age-ok';
      el.textContent = `✅ Age: ${m < 12 ? m+'mo' : Math.floor(m/12)+'y '+(m%12)+'mo'} — Eligible`;
    }
  }

  /* ── CONFIG PANEL ────────────────────────────────────── */
  function openConfigPanel() {
    if (!Security.can('canConfig')) { showToast('Only Administrators can access configuration.', 'error'); return; }
    const cfg = AppConfig.loadConfig();
    document.getElementById('cfgScriptUrl').value = cfg.scriptUrl || '';
    document.getElementById('cfgMemo').value      = cfg.memo      || '';
    document.getElementById('cfgCampaign').value  = cfg.campaign  || '';
    document.getElementById('cfgPeriod').value    = cfg.period    || '';
    document.getElementById('configPanel').classList.add('show');
  }

  function saveConfig() {
    const url = document.getElementById('cfgScriptUrl').value.trim();
    if (url) {
      try { API.setScriptUrl(url); } catch (e) { showToast(`❌ ${e.message}`, 'error'); return; }
    }
    AppConfig.set('scriptUrl', url);
    AppConfig.set('memo',      document.getElementById('cfgMemo').value.trim());
    AppConfig.set('campaign',  document.getElementById('cfgCampaign').value.trim());
    AppConfig.set('period',    document.getElementById('cfgPeriod').value.trim());
    renderHeader();
    document.getElementById('configPanel').classList.remove('show');
    showToast('✅ Configuration saved!', 'success');
    Security.auditLog('CONFIG_SAVED');
  }

  async function testConnection() {
    const url = document.getElementById('cfgScriptUrl').value.trim();
    const el  = document.getElementById('connStatus');
    el.style.display = 'inline-block';
    el.className = 'config-status';
    el.textContent = 'Testing…';
    if (!url) { el.textContent = '⚠ Enter URL first'; el.classList.add('err'); return; }
    try {
      API.setScriptUrl(url);
      const res = await API.testConnection();
      el.textContent = res ? '✅ Connected!' : '⚠ Unknown response';
      el.classList.add(res ? 'ok' : 'err');
    } catch (e) {
      // Fallback: try getAll
      try {
        const d = await API.getAll();
        el.textContent = `✅ Connected! ${Array.isArray(d) ? d.length + ' records' : ''}`;
        el.classList.add('ok');
      } catch {
        el.textContent = '❌ Connection failed. Check URL and deployment.';
        el.classList.add('err');
      }
    }
  }

  /* ── AUDIT LOG VIEW ──────────────────────────────────── */
  function showAuditLog() {
    if (!Security.can('canConfig')) { showToast('Admin access required.', 'error'); return; }
    const logs  = Security.getAuditLogs();
    const html  = logs.map(l => `<tr>
      <td class="td-dob">${Security.sanitize(l.timestamp.replace('T',' ').substring(0,19))}</td>
      <td><strong>${Security.sanitize(l.action)}</strong></td>
      <td>${Security.sanitize(l.username)}</td>
      <td>${Security.sanitize(l.role)}</td>
      <td>${Security.sanitize(JSON.stringify(l.details))}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty-state">No audit logs yet.</td></tr>';

    // FIX #1: Populate both the inline tab table AND the modal table so neither is ever blank.
    const tbody      = document.getElementById('auditTableBody');
    const modalTbody = document.getElementById('auditModalTableBody');
    if (tbody)      tbody.innerHTML      = html;
    if (modalTbody) modalTbody.innerHTML = html;

    document.getElementById('auditModal')?.classList.add('open');
  }

  /* ── LOGOUT ──────────────────────────────────────────── */
  function logout() {
    // Don't clear the shared record cache — other users need it
    // Only clear this user's session
    if (_loginClockTimer) clearInterval(_loginClockTimer);
    Security.destroySession('USER_LOGOUT');
    window.location.href = 'login.html';
  }

  /* ── TABS ────────────────────────────────────────────── */
  function switchTab(name, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + name)?.classList.add('active');
    if (name === 'summary') renderSummary();
    if (name === 'audit')   showAuditLog();
    Security.auditLog('TAB_SWITCH', { tab: name });
  }

  /* ── LOGIN CLOCK ────────────────────────────────────── */
  let _loginClockTimer = null;
  function startLoginClock() {
    if (_loginClockTimer) clearInterval(_loginClockTimer);
    const s = Security.getSession();
    if (!s) return;
    const loginTime = s.issuedAt;
    function update() {
      const elapsed = Math.floor((Date.now() - loginTime) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const sec = elapsed % 60;
      const txt = h > 0
        ? h + 'h ' + String(m).padStart(2,'0') + 'm ' + String(sec).padStart(2,'0') + 's'
        : m > 0
          ? m + 'm ' + String(sec).padStart(2,'0') + 's'
          : sec + 's';
      const el = document.getElementById('sessionTime');
      if (el) el.textContent = 'Logged in: ' + txt;
    }
    update();
    _loginClockTimer = setInterval(update, 1000);
  }

  /* ── HELPERS ─────────────────────────────────────────── */
  function calcAgeMonths(dob) {
    if (!dob) return null;
    // Normalize MM/DD/YYYY to a parseable format
    let dobStr = String(dob).trim();
    const mdY = dobStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdY) dobStr = mdY[3] + '-' + mdY[1].padStart(2,'0') + '-' + mdY[2].padStart(2,'0');
    const d   = new Date(dobStr);
    const now = new Date();
    let m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (now.getDate() < d.getDate()) m--;
    return isNaN(m) ? null : m;
  }

  function fmtDate(d) {
    if (!d) return '—';
    const s = String(d).trim();
    if (!s || s === '—') return '—';
    // Already MM/DD/YYYY — pass through
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
    // YYYY-MM-DD (from <input type="date">) — convert without timezone shift
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[2] + '/' + iso[3] + '/' + iso[1];
    // Fallback: parse as date
    const dt = new Date(s);
    if (isNaN(dt)) return s;
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return mm + '/' + dd + '/' + dt.getFullYear();
  }

  function getVal(id) {
    return (document.getElementById(id)?.value || '').trim();
  }

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function setBtnLoading(id, loading, text) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = loading;
    const sp  = btn.querySelector('.spinner');
    const tx  = btn.querySelector('.btn-text');
    if (sp) sp.style.display = loading ? 'block' : 'none';
    if (tx) tx.textContent = text;
  }

  function noData(cols) {
    return `<tr><td colspan="${cols}" style="padding:10px;color:var(--muted);text-align:center;">No data available</td></tr>`;
  }

  function highlight(text, q) {
    if (!q) return text;
    const regex = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi');
    return text.replace(regex, '<mark class="hl">$1</mark>');
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ── TOAST ───────────────────────────────────────────── */
  function showToast(msg, type = '') {
    const el  = document.getElementById('toast');
    if (!el)  return;
    el.textContent = Security.sanitize(msg);
    el.className   = type;
    el.style.display = 'block';
    el.setAttribute('role', 'alert');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  /* ── PUBLIC API ──────────────────────────────────────── */
  return {
    init,
    loadFromSheets,
    openModal,
    closeModal,
    saveRecord,
    editRecord,
    deleteRecord,
    exportCSV,
    calcAge,
    openConfigPanel,
    saveConfig,
    testConnection,
    logout,
    switchTab,
    showAuditLog,
    showToast,
  };

})();

window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());

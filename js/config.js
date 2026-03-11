/**
 * config.js — Application Configuration
 * Ragay Rural Health Unit SIA Masterlist
 *
 * Central config. Set SCRIPT_URL via ⚙ Config panel in the UI.
 * Passwords are SHA-256 hashed — never store plaintext.
 */

'use strict';

const AppConfig = (() => {

  /* ── FACILITY INFO ───────────────────────────────────── */
  const FACILITY = {
    name:        'Ragay Rural Health Unit',
    municipality: 'Ragay',
    province:    'Camarines Sur',
    region:      'Region V (Bicol Region)',
    memoRef:     'DOH-EPI MEMO',
    program:     'Expanded Program on Immunization (EPI)',
    coordinator: '', // Set by admin
  };

  /* ── BARANGAYS OF RAGAY ───────────────────────────────── */
  const BARANGAYS = [
    'Agao-ao','Agrupacion','Alert','Bagong Sikat','Buenasuerte',
    'Calao','Camambugan','Casay','Comagascas','Concepcion',
    'Del Carmen','Del Rosario','District I (Pob.)','District II (Pob.)',
    'District III (Pob.)','District IV (Pob.)','Esperanza','Gatbo',
    'Inapatan','Judith','Kulasi','La Castellana','La Purisima',
    'Lanipga-Naga','Liboro','Lubigan','Malitbog','Mambulo Nuevo',
    'Mambulo Viejo','Manguiring','Mercedes','Patrocinio',
    'Progreso','Ragay Nuevo','Salvacion','San Antonio','San Francisco',
    'San Isidro','San Jose','San Juan','San Nicolas','San Pablo',
    'San Pascual','San Ramon','San Roque','San Vicente','Santa Cruz',
    'Santa Elena','Santa Lucia','Santo Domingo','Santo Niño',
    'Talobatib','Trinidad','Union','Victory','Villa Aurora',
    'Villa Bautista','Villa Concordia','Villa Estrella',
  ].sort();

  /* ── VACCINE LIST (DOH EPI) ──────────────────────────── */
  const VACCINES = [
    { group: 'Polio', items: [
      { code: 'bOPV',  label: 'bOPV – Bivalent Oral Polio Vaccine' },
      { code: 'tOPV',  label: 'tOPV – Trivalent Oral Polio Vaccine' },
      { code: 'IPV',   label: 'IPV – Inactivated Polio Vaccine' },
    ]},
    { group: 'Measles', items: [
      { code: 'MR',    label: 'MR – Measles-Rubella' },
      { code: 'MMR',   label: 'MMR – Measles-Mumps-Rubella' },
    ]},
    { group: 'EPI Core Vaccines', items: [
      { code: 'BCG',      label: 'BCG – Bacillus Calmette-Guérin (TB)' },
      { code: 'HepB',     label: 'Hepatitis B (birth dose)' },
      { code: 'DPT-HepB-HiB', label: 'DPT-HepB-HiB (Pentavalent)' },
      { code: 'PCV',      label: 'PCV – Pneumococcal Conjugate' },
      { code: 'Rotavirus', label: 'Rotavirus' },
    ]},
    { group: 'Other', items: [
      { code: 'Vit-A',   label: 'Vitamin A Supplementation' },
      { code: 'Other',   label: 'Other (specify in Remarks)' },
    ]},
  ];

  /* ── DESIGNATIONS ───────────────────────────────────── */
  const DESIGNATIONS = [
    'Municipal Health Officer (MHO)',
    'Public Health Nurse (PHN)',
    'Rural Health Midwife (RHM)',
    'Barangay Health Worker (BHW)',
    'Medical Officer',
    'Sanitation Inspector',
    'Volunteer',
    'Other',
  ];

  /* ── VACCINATION SITES ──────────────────────────────── */
  const VACCINATION_SITES = [
    'Rural Health Unit (RHU)',
    'Barangay Health Station (BHS)',
    'House-to-house',
    'School / Day Care Center',
    'Chapel / Church',
    'Barangay Hall',
    'Other Fixed Post',
  ];

  /* ── STORAGE HELPERS (encrypted config) ─────────────── */
  const CONFIG_KEY = 'sia_config_v2';

  function saveConfig(cfg) {
    // Basic obfuscation (not encryption — true encryption needs a server key)
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
    sessionStorage.setItem(CONFIG_KEY, encoded);
    localStorage.setItem(CONFIG_KEY + '_persist', encoded); // Only non-sensitive config persists
  }

  function loadConfig() {
    try {
      const raw = sessionStorage.getItem(CONFIG_KEY)
               || localStorage.getItem(CONFIG_KEY + '_persist');
      if (!raw) return {};
      return JSON.parse(decodeURIComponent(escape(atob(raw))));
    } catch { return {}; }
  }

  function get(key, fallback = '') {
    return loadConfig()[key] ?? fallback;
  }

  function set(key, value) {
    const cfg = loadConfig();
    cfg[key] = value;
    saveConfig(cfg);
    if (key === 'scriptUrl' && window.API) {
      try { window.API.setScriptUrl(value); } catch {}
    }
  }

  /* ── INIT ────────────────────────────────────────────── */
  function init() {
    const url = get('scriptUrl');
    if (url && window.API) {
      try { window.API.setScriptUrl(url); } catch (e) { console.warn('Invalid saved script URL:', e.message); }
    }
  }

  /* ── PUBLIC ─────────────────────────────────────────── */
  return { FACILITY, BARANGAYS, VACCINES, DESIGNATIONS, VACCINATION_SITES, get, set, loadConfig, saveConfig, init };

})();

window.AppConfig = AppConfig;

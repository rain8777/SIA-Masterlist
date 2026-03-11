# 💉 SIA Masterlist System
### Ragay Rural Health Unit · DOH Philippines
**Supplemental Immunization Activity — Children 6–59 Months**

---

## 📁 File Structure

```
sia-masterlist/
├── index.html              ← Entry point (auto-redirects to login/dashboard)
├── login.html              ← Secure login page
├── dashboard.html          ← Main masterlist dashboard
├── vercel.json             ← Vercel deployment + security headers
├── README.md               ← This file
│
├── css/
│   ├── styles.css          ← Dashboard styles
│   └── login.css           ← Login page styles
│
├── js/
│   ├── security.js         ← Auth, CSRF, session, RBAC, audit, sanitization
│   ├── config.js           ← App config, barangay list, vaccines, dropdown data
│   ├── api.js              ← Google Sheets API client with security
│   └── app.js              ← Main application logic
│
└── appscript/
    └── Code.gs             ← Google Apps Script backend (paste into GAS editor)
```

---

## 🔐 Security Features

| Feature | Implementation |
|---|---|
| **Authentication** | Session-based with SHA-256 password hashing + salt |
| **Session Management** | sessionStorage only (never localStorage), 30-min inactivity timeout, 1-hr max |
| **CSRF Protection** | 256-bit random token, constant-time comparison, validated on every write |
| **Rate Limiting** | 5 attempts max, 15-min lockout per username |
| **RBAC** | 4 roles: Admin, Encoder, Vaccinator/BHW, Viewer |
| **Input Sanitization** | All inputs sanitized client + server side, regex validation per field type |
| **XSS Prevention** | All dynamic HTML uses textContent or sanitized innerText, mark.hl via regex |
| **HTTP Security Headers** | HSTS, CSP, X-Frame-Options: DENY, X-Content-Type-Options, Referrer-Policy |
| **Audit Logging** | Every action logged client-side (sessionStorage) + server-side (Google Sheet) |
| **Data Privacy** | RA 10173 compliance notice, access controls, no data in localStorage |
| **HTTPS** | Enforced via Vercel + HSTS header (63072000s = 2 years) |
| **Inactivity Timeout** | Auto-logout after 30 min, warning displayed in session bar |

---

## 🚀 Deployment Guide

### Step 1 — Google Sheets Setup

1. Create a new Google Sheet
2. Rename Sheet1 to `SIA_Masterlist`
3. Create a second sheet named `Users`
4. Create a third sheet named `AuditLog`
5. The Apps Script will auto-create headers on first run

### Step 2 — Google Apps Script

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Replace all code with the contents of `appscript/Code.gs`
3. Set your `SHEET_ID` (from the Sheet URL: `docs.google.com/spreadsheets/d/[SHEET_ID]/...`)
4. Click **Deploy → New Deployment**
5. Type: **Web App**
6. Execute as: **Me**
7. Who has access: **Anyone** *(required for the website to connect)*
8. Click **Deploy** and copy the Web App URL

### Step 3 — GitHub Setup

```bash
git init
git add .
git commit -m "SIA Masterlist initial commit"
git remote add origin https://github.com/YOUR_USERNAME/sia-masterlist.git
git push -u origin main
```

### Step 4 — Vercel Deployment

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **Add New → Project**
3. Select your `sia-masterlist` repository
4. Click **Deploy** (no build settings needed — it's static HTML)
5. Your site will be live at `https://sia-masterlist.vercel.app`

### Step 5 — Connect to Google Sheets

1. Visit your deployed site → Login as `admin`
2. Click **⚙️ Config** in the toolbar
3. Paste your Apps Script Web App URL
4. Click **🔌 Test Connection** → should show ✅ Connected
5. Click **🔄 Sync Sheets** to load data

---

## 👤 Default Users (Development Only)

| Username | Password | Role |
|---|---|---|
| `admin` | `admin·Rhu@2025!` | Administrator |
| `encoder1` | `encoder1·Rhu@2025!` | Data Encoder |
| `bhw1` | `bhw1·Rhu@2025!` | Vaccinator/BHW |
| `viewer` | `viewer·Rhu@2025!` | Read-Only Viewer |

> ⚠️ **IMPORTANT:** Delete the demo credentials box in `login.html` and change all passwords before deploying to production. In `Code.gs`, update the Users sheet with real SHA-256 hashed passwords.

---

## 🔒 Role Permissions

| Permission | Admin | Encoder | Vaccinator | Viewer |
|---|:---:|:---:|:---:|:---:|
| Add records | ✅ | ✅ | ✅ | ❌ |
| Edit records | ✅ | ✅ | ❌ | ❌ |
| Delete records | ✅ | ❌ | ❌ | ❌ |
| Export CSV | ✅ | ✅ | ❌ | ✅ |
| View config | ✅ | ❌ | ❌ | ❌ |
| View audit log | ✅ | ❌ | ❌ | ❌ |

---

## 📋 Google Apps Script Fallback (GAS Backup)

If Vercel/GitHub goes down, serve the app directly from Apps Script:

1. In Apps Script editor, click **+** next to Files → **HTML**
2. Name it `index` (not `index.html`)
3. Copy the contents of `index.html` into it
4. Your existing `doGet()` in `Code.gs` already handles this:
   - No `?action=` parameter → serves the HTML app
   - With `?action=...` → handles API requests

The same URL serves both the app AND the API. ✅

---

## 📞 Support

- DOH EPI Program: [https://doh.gov.ph/epi](https://doh.gov.ph/epi)
- Data Privacy: [https://privacy.gov.ph](https://privacy.gov.ph)
- Ragay RHU: Ragay, Camarines Sur, Region V

# SOL2 — School of Leaders 2 App

A rebrand of the LIFECLASS dashboard: same layout, screens, and features, recolored to a
royal blue / silver-slate palette for School of Leaders 2.

## What changed from LIFECLASS
- All "LIFECLASS" branding → "SOL2" / "School of Leaders 2" (title, manifest, sidebar,
  QR code prefix, printed reports, install prompts).
- Subtitle "Church Equipping Class" → "Leadership Equipping Class".
- Brand colors: navy → royal blue, green → steel-silver, purple → charcoal-slate.
  Status colors (present/absent, paid/unpaid, credits, podium gold/silver/bronze in the
  Gameshow feature) were intentionally left as-is since those are functional, not brand.
- New app icons (icon-192.png / icon-512.png) in the new palette.
- New empty database template: `SOL2_DATABASE.xlsx` — same 13 sheets/columns as
  LIFECLASS_DATABASE.xlsx, just empty and ready for your data.
- Backend script renamed to `SOL2_GAS_BACKEND.js` (same logic — only labels/comments changed).
- **Disconnected from the live LIFECLASS backend.** The original files had the real
  LIFECLASS Google Apps Script URL and Google Sheet ID hardcoded in `js/script1.js`,
  `gameshow.html`, and `SOL2_GAS_BACKEND.js` — meaning a copy run as-is would have read
  and written to the actual LIFECLASS data. Those have been replaced with clear
  placeholders (`GAS_URL` and `SPREADSHEET_ID`) that you must fill in yourself once you
  set up SOL2's own Google Sheet and deployment (steps below). Until you do, the app
  will show "Not connected" — that's expected and confirms it's no longer pointing at
  LIFECLASS.

## Setup steps
1. **Database**: Upload `SOL2_DATABASE.xlsx` to Google Drive → "Open with Google Sheets"
   (or File → Import into an existing Google Sheet). Fill in STUDENTS, FACULTY_STAFF, and
   TABLE_GUIDES with your program's real data.
2. **Backend**: Open the Google Sheet → Extensions → Apps Script. Paste in
   `SOL2_GAS_BACKEND.js`. Replace the `SPREADSHEET_ID` placeholder near the top with your
   sheet's ID (from its URL). Deploy → Manage deployments → New deployment → Web app,
   execute as "Me", access "Anyone".
3. **Front-end**: Host the folder (`index.html`, `gameshow.html`, `css/`, `js/`,
   `manifest.json`, `sw.js`, icons) anywhere static (GitHub Pages, Netlify, Vercel, etc).
   In `js/script1.js`, point the API base URL at your new Apps Script web app URL
   (same variable name/location as it was in the LIFECLASS front-end).
4. Open the hosted URL on a phone and "Add to Home Screen" to install it as a PWA.

## Notes
- Roles, tables, credits, payments, devotionals, leaderboard, make-up tracking, and the
  Gameshow trivia feature all work exactly as before — only labels and colors changed.
- If you'd like different terminology for "LG Leader" / "Network Leader" / "Table" to match
  SOL2's own structure, those are plain text labels and easy to find-and-replace further.

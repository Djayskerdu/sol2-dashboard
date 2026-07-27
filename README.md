# SOL2 — School of Leaders 2 App

A rebrand of the LIFECLASS dashboard: same layout, screens, and features, recolored to a
royal blue / silver-slate palette for School of Leaders 2.

## Two apps, one shared backend
This project is now **two separate apps that share the same Google Sheet + Apps Script backend**:

1. **Faculty & Staff app** (this folder: `index.html`, `gameshow.html`, `css/`, `js/`) — for
   Table Guides, Facilitators, Admins/Directors, and Record/QR staff. Unchanged except:
   - The old "Games Hub → SOL2 Level Challenge" screen (where a table guide checked quests
     off *for* a student) has been **removed**.
   - A new **Notifications** bell (home screen badge + full list) shows up whenever a
     student marks a Level Challenge quest complete themselves in the Student app.
2. **Student app** (new folder: `student/`) — a separate PWA for students. They log in with
   their **Student ID + PIN**, see their own progress, and check off their own weekly
   Level Challenge quests. Every quest they complete writes to the same
   `STUDENT_QUEST_PROGRESS` sheet and creates a row in a new `NOTIFICATIONS` sheet, which
   is what powers the Faculty app's bell.

## What changed from LIFECLASS
- All "LIFECLASS" branding → "SOL2" / "School of Leaders 2" (title, manifest, sidebar,
  QR code prefix, printed reports, install prompts).
- Subtitle "Church Equipping Class" → "Leadership Equipping Class".
- Brand colors: navy → royal blue, green → steel-silver, purple → charcoal-slate.
  Status colors (present/absent, paid/unpaid, credits, podium gold/silver/bronze in the
  Gameshow feature) were intentionally left as-is since those are functional, not brand.
- New app icons (icon-192.png / icon-512.png) in the new palette.
- New empty database template: `SOL2_DATABASE.xlsx` — same sheets/columns as
  LIFECLASS_DATABASE.xlsx, plus the new `PIN` column and `NOTIFICATIONS` sheet described
  below, just empty and ready for your data.
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
   - **STUDENTS**: fill in a **PIN** (4-6 digits, e.g. birth month+day) for every student —
     this is what they'll use with their Student ID to log into the Student app.
   - **NOTIFICATIONS**: leave this sheet empty with just its headers — rows are added
     automatically by the backend whenever a student completes a quest.
   - **STUDENT_QUEST_PROGRESS** (headers: `Quest ID | Student ID | Student Name | Table No |
     Level No | Quest No | Completed | Date Marked | Marked By`) still powers Team Games →
     SOL2 Level Challenge, but is now written to by the **Student app**, not Faculty.
2. **Backend**: Open the Google Sheet → Extensions → Apps Script. Paste in
   `SOL2_GAS_BACKEND.js`. Replace the `SPREADSHEET_ID` placeholder near the top with your
   sheet's ID (from its URL). Deploy → Manage deployments → New deployment → Web app,
   execute as "Me", access "Anyone".
3. **Faculty front-end**: Host this folder (`index.html`, `gameshow.html`, `css/`, `js/`,
   `manifest.json`, `sw.js`, icons) anywhere static (GitHub Pages, Netlify, Vercel, etc).
   In `js/script1.js`, point the API base URL at your new Apps Script web app URL
   (same variable name/location as it was in the LIFECLASS front-end).
4. **Student front-end**: Host the `student/` folder **separately** (its own subfolder,
   subdomain, or entirely different static host — e.g. `students.yoursite.com` or
   `yoursite.com/student/`). In `student/js/student.js`, paste the **same** `GAS_URL` from
   step 2 — both apps must point at the same Apps Script deployment so quest completions
   sync between them.
5. Open each hosted URL on a phone and "Add to Home Screen" to install as a PWA. Give
   students the Student app link/QR and their Student ID + PIN; give Faculty/Table Guides
   the Faculty app link/QR and their Username + Password.

## Notes
- Roles, tables, credits, payments, devotionals, leaderboard, make-up tracking, and the
  Gameshow trivia feature all work exactly as before — only labels and colors changed.
- **Team Games → SOL2 Level Challenge** (now student-facing): students log into their own
  app, tap the Level Challenge card on their home screen, and check off their own 3 quests
  per level (10 levels total) as they complete them in real life. Completing all 3 unlocks
  the next level. To edit the quest wording, edit the `QUESTS` object in **both**
  `js/script1.js` (kept for reference/back-compat) and `student/js/student.js` (search for
  "LEVEL CHALLENGE") — keep them in sync.
- **Notifications** (new, Faculty app): every time a student checks off a quest, a
  notification is created and shown as a badge on the Faculty home screen's bell icon.
  Table Guides only see notifications for their own table; Admin/Director accounts see all.
  Tap a notification to mark it read, or "✓ All" to clear every unread one for your table.
- If you'd like different terminology for "LG Leader" / "Network Leader" / "Table" to match
  SOL2's own structure, those are plain text labels and easy to find-and-replace further.

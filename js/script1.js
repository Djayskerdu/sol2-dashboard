// ╔═══════════════════════════════════════════════════════════╗
// ║  STEP 1 — PASTE YOUR GAS WEB APP URL BELOW               ║
// ╚═══════════════════════════════════════════════════════════╝
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwdtAmqs7wGa1S-niAn5KfiDsQHR-L-OuJPrJVkbyJf1OfAB1GvXQRIm7VAjwCz4Wvi/exec';

// ─── QR SECURITY TOKEN ───────────────────────────────────────
const QR_SECRET = 'LC2024-DAVAOCHURCH-8X';
const QR_PREFIX = `SOL2_APP:${QR_SECRET}:`;

// ═══════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function apiGet(action, params = "") {
  const url = `${GAS_URL}?action=${action}${params}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for action=${action}`);
  return await res.json();
}

async function apiPost(payload) {
  // text/plain avoids CORS preflight that Google Apps Script rejects
  const res = await fetchWithTimeout(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ═══════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════
let APP = {
  students: [],
  faculty: [],
  lessons: [],
  payments: [],
  attendance: [],
  facultyAttendance: [],
  credits: [],
  qrScans: [],
  tableGuides: [],
  settings: {},
  currentScreen: 's-portal',
  selectedReason: 'Attendance',
  currentWeek: 1,
  totalFee: 500,
  devotionals: {},   // studentId -> Set of completed day numbers (1-140)
  makeupStatus: {},  // attendanceId -> { status, notes }
  lessonCompletion: {},  // studentId -> { "moduleNo-lessonNo": "Done" | "Makeup" }
  lessonPoints: {},  // studentId -> { "moduleNo-lessonNo": { attendance, participation, homework, memoryVerse } }
  questProgress: {}  // studentId -> { "levelNo-questNo": true }  (Level Challenge game)
};

// Point-box categories shown per lesson in the Points grid. Each box's
// value is set by the facilitator when they check it (no fixed amount).
const POINT_CATEGORIES = [
  { key: 'attendance',    label: 'Attendance',    icon: '📋' },
  { key: 'participation', label: 'Participation', icon: '🙋' },
  { key: 'homework',      label: 'Homework',      icon: '📝' },
  { key: 'memoryVerse',   label: 'Memory Verse',  icon: '✝️' }
];

// ═══════════════════════════════════════════
// MODULE / LESSON COMPLETION — constants
// SOL2 = 2 Modules, 10 Lessons each (20 total). Used to determine
// Certificate of Completion eligibility.
// ═══════════════════════════════════════════
const TOTAL_MODULES = 2;
const LESSONS_PER_MODULE = 10;
const TOTAL_LESSONS = TOTAL_MODULES * LESSONS_PER_MODULE;

// ═══════════════════════════════════════════
// TABLE NAME HELPERS
// Returns the custom Table Name for a given table number.
// Falls back to "Table X" if no custom name is set.
// ═══════════════════════════════════════════
function getTableName(tableNo) {
  if (!tableNo && tableNo !== 0) return '—';
  const guide = APP.tableGuides.find(g => String(g['Table No']) === String(tableNo));
  return (guide && guide['Table Name'] && String(guide['Table Name']).trim())
    ? String(guide['Table Name']).trim()
    : null;
}

// Returns "Name | Table X" if a custom name exists, otherwise "Table X"
function getTableLabel(tableNo) {
  if (!tableNo && tableNo !== 0) return '—';
  const name = getTableName(tableNo);
  return name ? `${name} | Table ${tableNo}` : `Table ${tableNo}`;
}

// ═══════════════════════════════════════════
// ATTENDANCE TIME RULES
// 1:00 PM - 1:44 PM = Present
// 1:45 PM - 2:29 PM = Late
// 2:30 PM onwards   = Absent
// ═══════════════════════════════════════════
function getAttendanceStatusByTime() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const totalMin = h * 60 + m;
  const t_100 = 13 * 60 + 0;   // 1:00 PM
  const t_144 = 13 * 60 + 44;  // 1:44 PM
  const t_145 = 13 * 60 + 45;  // 1:45 PM
  const t_229 = 14 * 60 + 29;  // 2:29 PM
  const t_230 = 14 * 60 + 30;  // 2:30 PM

  if (totalMin >= t_100 && totalMin <= t_144) return 'Present';
  if (totalMin >= t_145 && totalMin <= t_229) return 'Late';
  if (totalMin >= t_230) return 'Absent';
  // Before 1:00 PM, treat as Present (early) 
  return 'Present';
}

function getAttendanceAlertMessage(status) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if (status === 'Present') return `✅ PRESENT — Scanned at ${timeStr}\n(1:00 PM – 1:44 PM window)`;
  if (status === 'Late')    return `⏰ LATE — Scanned at ${timeStr}\n(1:45 PM – 2:29 PM window)\n⚠️ 3 unexcused tardiness = 1 Absent`;
  if (status === 'Absent')  return `❌ ABSENT — Scanned at ${timeStr}\n(After 2:30 PM)\n⚠️ 3 unexcused absences = Drop`;
  return '';
}

// ═══════════════════════════════════════════
// DEVOTIONAL HELPERS — stored locally
// SOL2 devotional program = 20 weeks (140 days), grouped into 2 modules
// of 10 weeks each: Module 1 = Weeks 1-10, Module 2 = Weeks 11-20.
// ═══════════════════════════════════════════
const DEVOTIONAL_KEY_PREFIX = 'lc_devot_';
const TOTAL_DEVOTIONAL_DAYS = 140;
const DEVOTIONAL_WEEKS_PER_MODULE = 10;
const TOTAL_DEVOTIONAL_WEEKS = 20;
const DEVOTIONAL_DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// Given a day number (1-140), return { week, module, dayName }
function getDevotionalDayInfo(day) {
  const week = Math.ceil(day / 7);
  const module = Math.ceil(week / DEVOTIONAL_WEEKS_PER_MODULE);
  const dayName = DEVOTIONAL_DAY_NAMES[(day - 1) % 7];
  return { week, module, dayName };
}

// ── Devotionals (synced to Google Sheets) ───────────────────
function loadDevotionalsFromSheet(sheetRows) {
  APP.students.forEach(s => { APP.devotionals[s['Student ID']] = new Set(); });
  (sheetRows || []).forEach(row => {
    const sid = String(row['Student ID'] || '');
    const day = Number(row['Day No']);
    if (sid && day && (row['Completed'] === 'Yes' || row['Completed'] === true)) {
      if (!APP.devotionals[sid]) APP.devotionals[sid] = new Set();
      APP.devotionals[sid].add(day);
    }
  });
}

// Fallback: load from localStorage (legacy / offline)
function loadDevotionalsLocal() {
  APP.students.forEach(s => {
    if (APP.devotionals[s['Student ID']] && APP.devotionals[s['Student ID']].size > 0) return;
    const key = DEVOTIONAL_KEY_PREFIX + s['Student ID'];
    try {
      const saved = localStorage.getItem(key);
      APP.devotionals[s['Student ID']] = saved ? new Set(JSON.parse(saved)) : new Set();
    } catch(e) { APP.devotionals[s['Student ID']] = new Set(); }
  });
}

async function saveDevotional(studentId, day, checked) {
  if (!APP.devotionals[studentId]) APP.devotionals[studentId] = new Set();
  if (checked) APP.devotionals[studentId].add(day);
  else APP.devotionals[studentId].delete(day);
  // local backup
  try { localStorage.setItem(DEVOTIONAL_KEY_PREFIX + studentId, JSON.stringify([...APP.devotionals[studentId]])); } catch(e) {}
  // sync to sheet
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  try {
    await apiPost({ action: 'toggleDevotional', studentId, studentName: student?.['Full Name'] || '', tableNo: student?.['Table No'] || '', dayNo: day, completed: checked, markedBy: APP.currentFaculty?.['Full Name'] || '' });
  } catch(e) { console.warn('Devotional sync failed:', e); }
}

function getDevotionalCount(studentId) {
  return APP.devotionals[studentId] ? APP.devotionals[studentId].size : 0;
}

// ═══════════════════════════════════════════
// TEAM GAMES — LEVEL CHALLENGE
// 10 levels of real-life quests, 3 quests per level. A table guide
// checks a quest off after a student actually completes it; finishing
// all 3 quests in a level unlocks the next one. Level 10 is the grand
// finale — the "prize" is handed out in person at the closing program,
// there is no in-app reward.
// ═══════════════════════════════════════════
const QUEST_KEY_PREFIX = 'lc_quest_';
const TOTAL_LEVELS = 10;
const LEVEL_NAMES = {
  1: 'Getting Started',
  2: 'Daily Growth',
  3: 'Building Community',
  4: 'Serving Others',
  5: 'Sharing Faith',
  6: 'Growing Deeper',
  7: 'Discipleship',
  8: 'Leadership',
  9: 'Kingdom Impact',
  10: 'Mission Complete',
};
const QUESTS = {
  1: [
    { icon:'🎯', title:'Attend a LifeGroup' },
    { icon:'🤝', title:'Introduce yourself to a new member' },
    { icon:'📖', title:'Memorize one Bible verse' },
  ],
  2: [
    { icon:'📖', title:'Read the Bible for 5 consecutive days' },
    { icon:'🙏', title:'Pray for 10 minutes each day for 3 days' },
    { icon:'💬', title:'Share one takeaway from your Bible reading' },
  ],
  3: [
    { icon:'🎯', title:'Attend another LifeGroup' },
    { icon:'📖', title:'Encourage someone with a Bible verse' },
    { icon:'🤝', title:'Invite one friend to a LifeGroup' },
  ],
  4: [
    { icon:'🙌', title:'Volunteer during a church activity' },
    { icon:'🙏', title:'Pray with someone' },
    { icon:'❤️', title:'Perform one act of kindness without expecting anything in return' },
  ],
  5: [
    { icon:'💬', title:'Share your personal testimony' },
    { icon:'✝️', title:'Share the Gospel with one person' },
    { icon:'🎉', title:'Invite someone to church or a church event' },
  ],
  6: [
    { icon:'📖', title:'Complete a Bible study lesson' },
    { icon:'🙏', title:'Fast for one meal while praying' },
    { icon:'📖', title:'Memorize three Bible verses' },
  ],
  7: [
    { icon:'🤝', title:'Follow up with a first-time guest' },
    { icon:'🙏', title:'Pray for three friends by name' },
    { icon:'🎯', title:'Encourage someone to join a LifeGroup' },
  ],
  8: [
    { icon:'🗣️', title:'Help facilitate a LifeGroup activity' },
    { icon:'🌱', title:'Mentor or encourage a newer believer' },
    { icon:'🙏', title:'Lead the opening prayer in a gathering' },
  ],
  9: [
    { icon:'✝️', title:"Share God's Word with two people" },
    { icon:'🎉', title:'Bring one new guest to church' },
    { icon:'🌍', title:'Participate in an outreach or mission activity' },
  ],
  10: [
    { icon:'🎯', title:'Attend a LifeGroup' },
    { icon:'✝️', title:'Share the Gospel with three people' },
    { icon:'❤️', title:'Lead one person to Christ (or begin a discipleship journey with them)' },
  ],
};
function questsForLevel(lvl) { return QUESTS[lvl] || QUESTS[TOTAL_LEVELS]; }
function questKey(levelNo, questNo) { return levelNo + '-' + questNo; }

// ── Quest progress (synced to Google Sheets, same pattern as devotionals) ──
function loadQuestProgressFromSheet(sheetRows) {
  APP.students.forEach(s => { APP.questProgress[s['Student ID']] = {}; });
  (sheetRows || []).forEach(row => {
    const sid = String(row['Student ID'] || '');
    const lvl = Number(row['Level No']);
    const q   = Number(row['Quest No']);
    if (sid && lvl && q && (row['Completed'] === 'Yes' || row['Completed'] === true)) {
      if (!APP.questProgress[sid]) APP.questProgress[sid] = {};
      APP.questProgress[sid][questKey(lvl, q)] = true;
    }
  });
}

// Fallback: load from localStorage (legacy / offline) for students with no sheet data yet
function loadQuestProgressLocal() {
  APP.students.forEach(s => {
    const sid = s['Student ID'];
    if (APP.questProgress[sid] && Object.keys(APP.questProgress[sid]).length > 0) return;
    const key = QUEST_KEY_PREFIX + sid;
    try {
      const saved = localStorage.getItem(key);
      APP.questProgress[sid] = saved ? JSON.parse(saved) : {};
    } catch(e) { APP.questProgress[sid] = {}; }
  });
}

async function saveQuestToggle(studentId, levelNo, questNo, checked) {
  if (!APP.questProgress[studentId]) APP.questProgress[studentId] = {};
  if (checked) APP.questProgress[studentId][questKey(levelNo, questNo)] = true;
  else delete APP.questProgress[studentId][questKey(levelNo, questNo)];
  // local backup
  try { localStorage.setItem(QUEST_KEY_PREFIX + studentId, JSON.stringify(APP.questProgress[studentId])); } catch(e) {}
  // sync to sheet
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  try {
    await apiPost({ action: 'toggleQuest', studentId, studentName: student?.['Full Name'] || '', tableNo: student?.['Table No'] || '', levelNo, questNo, completed: checked, markedBy: APP.currentFaculty?.['Full Name'] || '' });
  } catch(e) { console.warn('Quest sync failed:', e); }
}

// Is every quest in this level checked off for this student?
function isLevelDoneFor(studentId, levelNo) {
  const state = APP.questProgress[studentId] || {};
  const quests = questsForLevel(levelNo);
  for (let i = 0; i < quests.length; i++) {
    if (!state[questKey(levelNo, i + 1)]) return false;
  }
  return true;
}

// Highest fully-completed level for a student (0 = none yet)
function getHighestLevel(studentId) {
  let highest = 0;
  for (let lvl = 1; lvl <= TOTAL_LEVELS; lvl++) {
    if (isLevelDoneFor(studentId, lvl)) highest = lvl;
    else break;
  }
  return highest;
}

function lcInitials(name) {
  return (name || '?').split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

let currentLCStudent = null;
let currentLCLevel = 1;

function renderLCRoster() {
  const grid = document.getElementById('lc-roster-grid');
  const label = document.getElementById('lc-roster-label');
  if (!grid) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const roster = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (label) label.textContent = getTableLabel(tableNo) + ' roster';
  if (!roster.length) {
    grid.innerHTML = '<p style="padding:16px;color:var(--text3);grid-column:1/-1">No students found for your table.</p>';
    return;
  }
  grid.innerHTML = roster.map(s => {
    const sid = s['Student ID'];
    const done = getHighestLevel(sid);
    const active = currentLCStudent && String(currentLCStudent['Student ID']) === String(sid);
    return `
      <div class="roster-card${active ? ' active-student' : ''}" onclick="selectLCStudent('${sid}')">
        <div class="roster-av">${lcInitials(s['Full Name'])}</div>
        <div class="roster-name">${s['Full Name']}</div>
        <div class="roster-progress">${done}/${TOTAL_LEVELS} levels</div>
      </div>`;
  }).join('');
}

function selectLCStudent(studentId) {
  const s = APP.students.find(st => String(st['Student ID']) === String(studentId));
  if (!s) return;
  currentLCStudent = s;
  document.getElementById('lc-csb-av').textContent = lcInitials(s['Full Name']);
  document.getElementById('lc-csb-name').textContent = s['Full Name'];
  renderLCMap();
  go('s-lc-map');
}

const LC_NODE_X = [160,235,160,85,160,235,160,85,160,160];
const LC_NODE_Y = [940,845,750,655,560,465,370,275,180,85];

function renderLCMap() {
  const wrap = document.getElementById('lc-map-scroll');
  if (!wrap || !currentLCStudent) return;
  const highest = getHighestLevel(currentLCStudent['Student ID']);
  const vbH = LC_NODE_Y[0] + 60;
  let svg = `<svg class="map-svg" viewBox="0 0 320 ${vbH}" xmlns="http://www.w3.org/2000/svg">`;

  let pathD = `M ${LC_NODE_X[0]} ${LC_NODE_Y[0]}`;
  for (let i = 1; i < TOTAL_LEVELS; i++) pathD += ` L ${LC_NODE_X[i]} ${LC_NODE_Y[i]}`;
  svg += `<path d="${pathD}" class="path-line"/>`;

  for (let i = 0; i < TOTAL_LEVELS; i++) {
    const lvl = i + 1;
    const completed = lvl <= highest;
    const unlocked = lvl <= highest + 1;
    const isFinale = lvl === TOTAL_LEVELS;
    let cls = 'lvl-node ' + (isFinale ? 'finale-node ' : '') + (completed ? 'completed' : (unlocked ? 'current' : 'locked'));
    const r = isFinale ? 34 : 30;
    svg += `<g class="${cls}" data-level="${lvl}" onclick="tapLCLevelNode(${lvl})">`;
    svg += `<circle class="base" cx="${LC_NODE_X[i]}" cy="${LC_NODE_Y[i]}" r="${r}"/>`;
    if (!unlocked) {
      svg += `<text x="${LC_NODE_X[i]}" y="${LC_NODE_Y[i]+1}" font-size="20" text-anchor="middle" dominant-baseline="central">🔒</text>`;
    } else if (isFinale) {
      svg += `<text x="${LC_NODE_X[i]}" y="${LC_NODE_Y[i]+1}" font-size="26" text-anchor="middle" dominant-baseline="central">🏆</text>`;
    } else if (completed) {
      svg += `<text x="${LC_NODE_X[i]}" y="${LC_NODE_Y[i]+1}" font-size="24" text-anchor="middle" dominant-baseline="central">✓</text>`;
    } else {
      svg += `<text class="lvl-num" x="${LC_NODE_X[i]}" y="${LC_NODE_Y[i]+1}">${lvl}</text>`;
    }
    svg += `</g>`;
  }
  svg += `</svg>`;

  const banner = `<div style="padding:14px 18px 4px">
    <div style="background:#fff;border-radius:14px;padding:12px 14px;box-shadow:var(--shadow);font-size:12px;color:var(--text2);line-height:1.5">
      🏆 <b>Level 10</b> is the grand finale — there's no in-app prize, the real surprise is handed out at the SOL2 closing program once every level's quests are done.
    </div>
  </div>`;

  wrap.innerHTML = banner + svg;
}

function tapLCLevelNode(lvl) {
  if (!currentLCStudent) return;
  const highest = getHighestLevel(currentLCStudent['Student ID']);
  if (lvl > highest + 1) {
    toastLCLocked();
    return;
  }
  openLCQuests(lvl);
  go('s-lc-quests');
}

function toastLCLocked() {
  const bar = document.querySelector('#s-lc-map .current-student-bar');
  if (!bar) return;
  bar.classList.add('lc-shake');
  setTimeout(() => bar.classList.remove('lc-shake'), 300);
}

function openLCQuests(lvl) {
  currentLCLevel = lvl;
  document.getElementById('lc-game-overlay').classList.remove('show');
  document.getElementById('lc-quest-topbar-title').textContent = 'Level ' + lvl + ' — ' + LEVEL_NAMES[lvl];
  document.getElementById('lc-quest-sub-label').textContent =
    lvl === TOTAL_LEVELS
      ? 'Finish all 3 to complete the SOL2 Level Challenge'
      : `Finish all 3 quests to unlock Level ${lvl + 1}`;
  renderLCQuestList();
}

function renderLCQuestList() {
  if (!currentLCStudent) return;
  const sid = currentLCStudent['Student ID'];
  const state = APP.questProgress[sid] || {};
  const quests = questsForLevel(currentLCLevel);
  const list = document.getElementById('lc-quest-list');
  list.innerHTML = quests.map((q, idx) => {
    const done = !!state[questKey(currentLCLevel, idx + 1)];
    return `
      <div class="quest-card${done ? ' qc-done' : ''}">
        <div class="quest-icon">${q.icon}</div>
        <div class="quest-text">
          <div class="quest-title">${q.title}</div>
          <div class="quest-hint">Quest ${idx + 1} of ${quests.length}</div>
        </div>
        <div class="quest-check${done ? ' checked' : ''}" onclick="toggleLCQuest(${idx})">${done ? '✓' : ''}</div>
      </div>`;
  }).join('');
  updateLCQuestProgress();
}

async function toggleLCQuest(idx) {
  if (!currentLCStudent) return;
  const sid = currentLCStudent['Student ID'];
  const wasDone = !!(APP.questProgress[sid] || {})[questKey(currentLCLevel, idx + 1)];
  await saveQuestToggle(sid, currentLCLevel, idx + 1, !wasDone);
  renderLCQuestList();
  if (isLevelDoneFor(sid, currentLCLevel)) {
    setTimeout(finishLCLevel, 350);
  }
}

function updateLCQuestProgress() {
  if (!currentLCStudent) return;
  const sid = currentLCStudent['Student ID'];
  const state = APP.questProgress[sid] || {};
  const quests = questsForLevel(currentLCLevel);
  const doneCount = quests.filter((q, idx) => state[questKey(currentLCLevel, idx + 1)]).length;
  document.getElementById('lc-quest-progress-fill').style.width = (doneCount / quests.length * 100) + '%';
}

function finishLCLevel() {
  const isFinale = currentLCLevel === TOTAL_LEVELS;
  const overlay = document.getElementById('lc-game-overlay');
  const nextBtn = document.getElementById('lc-overlay-next-btn');
  if (isFinale) {
    document.getElementById('lc-overlay-emoji').textContent = '🏆';
    document.getElementById('lc-overlay-title').textContent = 'All 10 Levels Complete!';
    document.getElementById('lc-overlay-sub').textContent =
      currentLCStudent['Full Name'] + ' finished every quest in the SOL2 Level Challenge. No points here — tell your table guide, the real surprise is waiting at the closing program!';
    nextBtn.style.display = 'none';
  } else {
    document.getElementById('lc-overlay-emoji').textContent = '⭐';
    document.getElementById('lc-overlay-title').textContent = 'Level ' + currentLCLevel + ' Complete!';
    document.getElementById('lc-overlay-sub').textContent = 'All quests done. Level ' + (currentLCLevel + 1) + ' is now unlocked.';
    nextBtn.style.display = 'block';
    nextBtn.textContent = 'Next Level →';
  }
  overlay.classList.add('show');
  launchLCConfetti(overlay);
}

function closeLCOverlayToMap() {
  renderLCMap();
  go('s-lc-map');
}

function goToNextLCLevelFromOverlay() {
  openLCQuests(Math.min(currentLCLevel + 1, TOTAL_LEVELS));
}

function launchLCConfetti(container) {
  const colors = ['#e0a83a', '#ffffff', '#7c9cf0', '#e0442f'];
  for (let i = 0; i < 26; i++) {
    const c = document.createElement('div');
    c.className = 'lc-confetti';
    c.style.left = (Math.random() * 100) + '%';
    c.style.width = (5 + Math.random() * 4) + 'px';
    c.style.height = (8 + Math.random() * 6) + 'px';
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = (Math.random() * 0.4) + 's';
    container.appendChild(c);
    setTimeout(() => c.remove(), 2200);
  }
}

// ── Makeup Status ────────────────────────────────────────────
function loadMakeupStatusFromSheet(rows) {
  APP.makeupStatus = {};
  (rows || []).forEach(row => {
    const attId = String(row['Attendance ID'] || '');
    if (attId) APP.makeupStatus[attId] = { status: row['Status'] || 'Pending', notes: row['Notes'] || '' };
  });
}

async function saveMakeupStatus(attendanceId, status, studentId, studentName, weekNo, tableNo, notes) {
  APP.makeupStatus[attendanceId] = { status, notes: notes || '' };
  try {
    await apiPost({ action: 'updateMakeupStatus', attendanceId, studentId, studentName, weekNo, tableNo, status, updatedBy: APP.currentFaculty?.['Full Name'] || 'Admin', notes: notes || '' });
  } catch(e) { console.warn('Makeup status sync failed:', e); }
}

// ── Module / Lesson Completion (drives Certificate of Completion) ──────
function lessonKey(moduleNo, lessonNo) { return moduleNo + '-' + lessonNo; }

function loadLessonCompletionFromSheet(rows) {
  APP.students.forEach(s => { APP.lessonCompletion[s['Student ID']] = {}; });
  (rows || []).forEach(row => {
    const sid = String(row['Student ID'] || '');
    const mod = Number(row['Module No']);
    const les = Number(row['Lesson No']);
    const status = row['Status'] || '';
    if (sid && mod && les) {
      if (!APP.lessonCompletion[sid]) APP.lessonCompletion[sid] = {};
      if (status === 'Done' || status === 'Makeup') APP.lessonCompletion[sid][lessonKey(mod, les)] = status;
    }
  });
}

function getLessonStatus(studentId, moduleNo, lessonNo) {
  const rec = APP.lessonCompletion[studentId];
  return (rec && rec[lessonKey(moduleNo, lessonNo)]) || '';
}

// Count of lessons marked "Done" within a single module (1 or 2)
function getModuleDoneCount(studentId, moduleNo) {
  const rec = APP.lessonCompletion[studentId] || {};
  let count = 0;
  for (let l = 1; l <= LESSONS_PER_MODULE; l++) if (rec[lessonKey(moduleNo, l)] === 'Done') count++;
  return count;
}

// Count of lessons marked "Done" across both modules (out of TOTAL_LESSONS)
function getTotalLessonsDoneCount(studentId) {
  return getModuleDoneCount(studentId, 1) + getModuleDoneCount(studentId, 2);
}

// Count of lessons marked "Makeup" across both modules
function getTotalLessonsMakeupCount(studentId) {
  const rec = APP.lessonCompletion[studentId] || {};
  let count = 0;
  for (let m = 1; m <= TOTAL_MODULES; m++)
    for (let l = 1; l <= LESSONS_PER_MODULE; l++)
      if (rec[lessonKey(m, l)] === 'Makeup') count++;
  return count;
}

// Certificate of Completion eligibility: every single lesson in both
// modules must be marked "Done" — no make-up classes, no blanks.
function isCertificateEligible(studentId) {
  return getTotalLessonsDoneCount(studentId) === TOTAL_LESSONS;
}

// ── Lesson Points grid (per-lesson Attendance/Participation/Homework/Memory
// Verse checkboxes — replaces the old manual "Add Points" form) ──────────
function loadLessonPointsFromSheet(rows) {
  APP.students.forEach(s => { APP.lessonPoints[s['Student ID']] = {}; });
  (rows || []).forEach(row => {
    const sid = String(row['Student ID'] || '');
    const mod = Number(row['Module No']);
    const les = Number(row['Lesson No']);
    if (sid && mod && les) {
      if (!APP.lessonPoints[sid]) APP.lessonPoints[sid] = {};
      APP.lessonPoints[sid][lessonKey(mod, les)] = {
        attendance:    Number(row['Attendance Points'] || 0),
        participation: Number(row['Participation Points'] || 0),
        homework:      Number(row['Homework Points'] || 0),
        memoryVerse:   Number(row['Memory Verse Points'] || 0)
      };
    }
  });
}

// Current point value of a single box (0 = unchecked)
function getLessonPointBox(studentId, moduleNo, lessonNo, categoryKey) {
  const rec = APP.lessonPoints[studentId];
  const cell = rec && rec[lessonKey(moduleNo, lessonNo)];
  return cell ? Number(cell[categoryKey] || 0) : 0;
}

// Sum of all 4 boxes for one lesson row
function getLessonPointsRowTotal(studentId, moduleNo, lessonNo) {
  const rec = APP.lessonPoints[studentId];
  const cell = rec && rec[lessonKey(moduleNo, lessonNo)];
  if (!cell) return 0;
  return POINT_CATEGORIES.reduce((sum, c) => sum + Number(cell[c.key] || 0), 0);
}

// Sum of every box across all 20 lessons for a student — this is the
// student's total from the points grid (added to any legacy manual credits).
function getStudentLessonPointsTotal(studentId) {
  const rec = APP.lessonPoints[studentId] || {};
  let total = 0;
  Object.keys(rec).forEach(k => {
    POINT_CATEGORIES.forEach(c => { total += Number(rec[k][c.key] || 0); });
  });
  return total;
}

// ═══════════════════════════════════════════
// CERTIFICATE OF COMPLETION — PDF generation
// Fills "CERTIFICATE PLAIN TEMPLATE.pdf" with the student's name and
// today's date, then downloads it. Coordinates below were measured
// against the template's own printed guide lines (name underline and
// the DATE signature line), so they line up with the design exactly.
// ═══════════════════════════════════════════
const CERT_TEMPLATE_URL = encodeURI('CERTIFICATE PLAIN TEMPLATE.pdf');
const ROBOTO_BOLD_URL   = encodeURI('fonts/Roboto-Bold.ttf');

async function generateCertificate(studentId) {
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  if (!student) { alert('Student not found.'); return; }
  if (!isCertificateEligible(studentId)) { alert('This student has not completed all 20 lessons yet.'); return; }

  const btn = document.getElementById('modcomp-cert-btn');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    if (typeof PDFLib === 'undefined') throw new Error('PDF library did not load. Check your connection and try again.');
    if (typeof fontkit === 'undefined') throw new Error('Font library did not load. Check your connection and try again.');

    const bytes = await fetch(CERT_TEMPLATE_URL).then(r => {
      if (!r.ok) throw new Error('Could not load certificate template (' + r.status + ').');
      return r.arrayBuffer();
    });
    const robotoBytes = await fetch(ROBOTO_BOLD_URL).then(r => {
      if (!r.ok) throw new Error('Could not load Roboto font (' + r.status + ').');
      return r.arrayBuffer();
    });

    const pdfDoc  = await PDFLib.PDFDocument.load(bytes);
    pdfDoc.registerFontkit(fontkit);
    const page    = pdfDoc.getPages()[0];
    const { width: pageW, height: pageH } = page.getSize();
    const font    = await pdfDoc.embedFont(robotoBytes); // Roboto Bold
    const green   = PDFLib.rgb(0x0d/255, 0x47/255, 0x2b/255);
    const black   = PDFLib.rgb(0.1, 0.1, 0.1);

    // Coordinates below were measured as pixel positions on the reference
    // template image, which is 2000 x 1545 px (CERTIFICATE PLAIN TEMPLATE.png).
    // Convert px -> pt using the actual page width/height (NOT a single
    // shared ratio) since the reference image isn't square.
    const REF_IMG_W = 2000;
    const REF_IMG_H = 1545;
    const scaleX = pageW / REF_IMG_W;
    const scaleY = pageH / REF_IMG_H;
    // px (x, yFromTop) -> pt {x, y} (y from bottom, as drawText expects)
    const pxToPt = (px, py) => ({ x: px * scaleX, y: pageH - (py * scaleY) });

    // Name — centered on the underline beneath "presented to"
    const name = (student['Full Name'] || '').toUpperCase();
    const namePt = pxToPt(667.5, 660);
    const nameMaxWidth    = 280; // available width above the underline
    let nameSize = 30;
    while (nameSize > 12 && font.widthOfTextAtSize(name, nameSize) > nameMaxWidth) nameSize -= 1;
    const nameWidth = font.widthOfTextAtSize(name, nameSize);
    page.drawText(name, {
      x: namePt.x - nameWidth / 2,
      y: namePt.y,
      size: nameSize,
      font,
      color: green
    });

    // Equipping class name — centered under "for the successful completion of".
    // Pulled straight from SYSTEM_SETTINGS: Batch Name (e.g. "School of Leaders 2").
    const className = (APP.settings && APP.settings['Batch Name']) ? String(APP.settings['Batch Name']).toUpperCase() : '';
    const classPt = pxToPt(666.5, 910);
    const classMaxWidth = 300; // available width on that line
    let classSize = 22;
    while (classSize > 10 && font.widthOfTextAtSize(className, classSize) > classMaxWidth) classSize -= 1;
    const classWidth = font.widthOfTextAtSize(className, classSize);
    page.drawText(className, {
      x: classPt.x - classWidth / 2,
      y: classPt.y,
      size: classSize,
      font,
      color: green
    });

    // Date — centered above the "DATE" signature line, baseline aligned
    // with the "LEMUEL P. QUILOS" text on the right so the whole row sits even.
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase();
    const datePt = pxToPt(314, 1334);
    const fieldSize = 12.7;
    const dateWidth = font.widthOfTextAtSize(dateStr, fieldSize);
    page.drawText(dateStr, {
      x: datePt.x - dateWidth / 2,
      y: datePt.y,
      size: fieldSize,
      font,
      color: black
    });

    // Student ID — centered under the description paragraph, above the
    // DATE / LEAD PASTOR row. Taken straight from the STUDENTS sheet.
    const studentIdStr = String(student['Student ID'] || '');
    const studentIdPt = pxToPt(670, 1270);
    const studentIdWidth = font.widthOfTextAtSize(studentIdStr, fieldSize);
    page.drawText(studentIdStr, {
      x: studentIdPt.x - studentIdWidth / 2,
      y: studentIdPt.y,
      size: fieldSize,
      font,
      color: green
    });

    const outBytes = await pdfDoc.save();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);

    const link = document.getElementById('cert-download-link');
    link.href = url;
    link.download = `Certificate - ${student['Full Name'] || studentId}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

  } catch (err) {
    console.error('Certificate generation failed:', err);
    alert('Could not generate the certificate: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

// ═══════════════════════════════════════════
// CERTIFICATE OF APPRECIATION (DEVOTIONAL) — PDF generation
// Same idea as the Module Completion certificate above, but earned by
// checking off all 140 devotional days instead of all 20 lessons, and
// filled onto "CERTIFICATE OF DEVOTIONAL PLAIN TEMPLATE.pdf". That
// template shares the exact same layout grid as the completion one
// (name / student ID / date all sit at identical coordinates), so the
// same pxToPt math is reused as-is.
// ═══════════════════════════════════════════
const DEVOTIONAL_CERT_TEMPLATE_URL = encodeURI('CERTIFICATE OF DEVOTIONAL PLAIN TEMPLATE.pdf');

// Devotional certificate eligibility: every one of the 140 devotional
// days must be checked off — no gaps.
function isDevotionalCertificateEligible(studentId) {
  return getDevotionalCount(studentId) === TOTAL_DEVOTIONAL_DAYS;
}

async function generateDevotionalCertificate(studentId) {
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  if (!student) { alert('Student not found.'); return; }
  if (!isDevotionalCertificateEligible(studentId)) { alert('This student has not completed all 140 devotional days yet.'); return; }

  const btn = document.getElementById('devot-cert-btn');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    if (typeof PDFLib === 'undefined') throw new Error('PDF library did not load. Check your connection and try again.');
    if (typeof fontkit === 'undefined') throw new Error('Font library did not load. Check your connection and try again.');

    const bytes = await fetch(DEVOTIONAL_CERT_TEMPLATE_URL).then(r => {
      if (!r.ok) throw new Error('Could not load certificate template (' + r.status + ').');
      return r.arrayBuffer();
    });
    const robotoBytes = await fetch(ROBOTO_BOLD_URL).then(r => {
      if (!r.ok) throw new Error('Could not load Roboto font (' + r.status + ').');
      return r.arrayBuffer();
    });

    const pdfDoc  = await PDFLib.PDFDocument.load(bytes);
    pdfDoc.registerFontkit(fontkit);
    const page    = pdfDoc.getPages()[0];
    const { width: pageW, height: pageH } = page.getSize();
    const font    = await pdfDoc.embedFont(robotoBytes); // Roboto Bold
    const green   = PDFLib.rgb(0x0d/255, 0x47/255, 0x2b/255);
    const black   = PDFLib.rgb(0.1, 0.1, 0.1);

    const REF_IMG_W = 2000;
    const REF_IMG_H = 1545;
    const scaleX = pageW / REF_IMG_W;
    const scaleY = pageH / REF_IMG_H;
    const pxToPt = (px, py) => ({ x: px * scaleX, y: pageH - (py * scaleY) });

    // Name — centered on the underline beneath "presented to".
    const name = (student['Full Name'] || '').toUpperCase();
    const namePt = pxToPt(667.5, 660);
    const nameMaxWidth = 280;
    let nameSize = 30;
    while (nameSize > 12 && font.widthOfTextAtSize(name, nameSize) > nameMaxWidth) nameSize -= 1;
    const nameWidth = font.widthOfTextAtSize(name, nameSize);
    page.drawText(name, {
      x: namePt.x - nameWidth / 2,
      y: namePt.y,
      size: nameSize,
      font,
      color: green
    });

    // Date — centered above the "DATE" signature line.
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase();
    const datePt = pxToPt(314, 1334);
    const fieldSize = 12.7;
    const dateWidth = font.widthOfTextAtSize(dateStr, fieldSize);
    page.drawText(dateStr, {
      x: datePt.x - dateWidth / 2,
      y: datePt.y,
      size: fieldSize,
      font,
      color: black
    });

    // Student ID — centered under the description paragraph.
    const studentIdStr = String(student['Student ID'] || '');
    const studentIdPt = pxToPt(670, 1270);
    const studentIdWidth = font.widthOfTextAtSize(studentIdStr, fieldSize);
    page.drawText(studentIdStr, {
      x: studentIdPt.x - studentIdWidth / 2,
      y: studentIdPt.y,
      size: fieldSize,
      font,
      color: green
    });

    const outBytes = await pdfDoc.save();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);

    const link = document.getElementById('cert-download-link');
    link.href = url;
    link.download = `Certificate of Appreciation - ${student['Full Name'] || studentId}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

  } catch (err) {
    console.error('Devotional certificate generation failed:', err);
    alert('Could not generate the certificate: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

async function saveLessonStatus(studentId, moduleNo, lessonNo, status) {
  if (!APP.lessonCompletion[studentId]) APP.lessonCompletion[studentId] = {};
  if (status) APP.lessonCompletion[studentId][lessonKey(moduleNo, lessonNo)] = status;
  else delete APP.lessonCompletion[studentId][lessonKey(moduleNo, lessonNo)];

  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  try {
    await apiPost({
      action: 'toggleLessonCompletion',
      studentId,
      studentName: student?.['Full Name'] || '',
      tableNo: student?.['Table No'] || '',
      moduleNo, lessonNo, status,
      markedBy: APP.currentFaculty?.['Full Name'] || ''
    });
  } catch(e) { console.warn('Lesson completion sync failed:', e); }
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadAllData();
  initClock();
  updateSyncStatus(false);
});

// ═══════════════════════════════════════════
// LOAD ALL DATA
// ═══════════════════════════════════════════
function safeData(settled) {
  if (settled.status === 'rejected') {
    console.warn('API call failed:', settled.reason);
    return [];
  }
  return settled.value?.data || [];
}

async function loadAllData() {
  updateSyncStatus(false);
  const results = await Promise.allSettled([
    apiGet('students'),
    apiGet('faculty'),
    apiGet('credits'),
    apiGet('payments'),
    apiGet('studentAttendance'),
    apiGet('facultyAttendance'),
    apiGet('lessonWeeks'),
    apiGet('qrscans'),
    apiGet('tableGuides'),
    apiGet('settings'),
    apiGet('devotionals'),
    apiGet('makeupStatus'),
    apiGet('lessonCompletion'),
    apiGet('lessonPoints'),
    apiGet('questProgress')
  ]);

  APP.students          = safeData(results[0]);
  APP.faculty           = safeData(results[1]);
  APP.credits           = safeData(results[2]);
  APP.payments          = safeData(results[3]);
  APP.attendance        = safeData(results[4]);
  APP.facultyAttendance = safeData(results[5]);
  APP.lessons           = safeData(results[6]);
  APP.qrScans           = safeData(results[7]);
  APP.tableGuides       = safeData(results[8]);

  const settingsData = safeData(results[9]);
  if (settingsData.length) {
    settingsData.forEach(row => { APP.settings[row['Setting']] = row['Value']; });
    APP.currentWeek = Number(APP.settings['Current Week'] || 1);
    APP.totalFee    = Number(APP.settings['Total Class Fee'] || 500);
  }

  const devotionalRows = safeData(results[10]);
  const makeupRows     = safeData(results[11]);
  const lessonCompletionRows = safeData(results[12]);
  const lessonPointsRows     = safeData(results[13]);
  const questProgressRows    = safeData(results[14]);

  loadDevotionalsFromSheet(devotionalRows);
  loadDevotionalsLocal();   // fill blanks from localStorage (offline fallback)
  loadMakeupStatusFromSheet(makeupRows);
  loadLessonCompletionFromSheet(lessonCompletionRows);
  loadLessonPointsFromSheet(lessonPointsRows);
  loadQuestProgressFromSheet(questProgressRows);
  loadQuestProgressLocal();  // fill blanks from localStorage (offline fallback)

  const failCount = results.slice(0, 10).filter(r => r.status === 'rejected').length;

  populateCreditStudentSelect();
  populatePayStudentSelect();
  populateWeekDropdowns();
  updateAdminHomeStats();
  updateFacultyHome();
  renderRecordStats();
  renderBalancesSummary();
  refreshCurrentScreen();

  if (failCount === 10) {
    updateSyncStatus(false, 'Cannot reach server — check GAS_URL');
    showConnectionError();
  } else if (failCount > 0) {
    updateSyncStatus(false, failCount + ' source(s) failed to load');
  } else {
    updateSyncStatus(true);
  }
}

function showConnectionError() {
  const el = document.getElementById('sync-label-portal');
  if (el) {
    el.innerHTML = '⚠️ <strong>Not connected.</strong> Set GAS_URL in script1.js, then redeploy.';
    el.style.color = '#c0392b';
    el.style.fontSize = '12px';
  }
}

// ═══════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(20px)';
  }, duration);
}

// ═══════════════════════════════════════════
// REASON SELECTOR
// ═══════════════════════════════════════════
function selectReason(btn, reason) {
  const grid = btn.closest('.reason-grid');
  if (grid) grid.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  APP.selectedReason = reason;

  const creditOther = document.getElementById('credit-other-wrap');
  if (creditOther) creditOther.style.display = (reason === '__other__' && btn.closest('#s-add-credit')) ? '' : 'none';
  const modalOther = document.getElementById('modal-other-wrap');
  if (modalOther) modalOther.style.display = (reason === '__other__' && btn.closest('#modal-table-credit')) ? '' : 'none';
}

// ═══════════════════════════════════════════
// POPULATE SELECTS
// ═══════════════════════════════════════════
function populateCreditStudentSelect() {
  const sel = document.getElementById('credit-student-sel');
  if (!sel) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  sel.innerHTML = filtered.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]}</option>`
  ).join('');
}

// ═══════════════════════════════════════════
// REFRESH CURRENT SCREEN
// ═══════════════════════════════════════════
function refreshCurrentScreen() {
  const id = APP.currentScreen;
  if (id === 's-faculty-home')  updateFacultyHome();
  if (id === 's-f-lessons')     renderWeeks('f');
  if (id === 's-f-students')    renderFStudents();
  if (id === 's-f-payment')     renderFPayment();
  if (id === 's-f-credits')     renderFCredits();
  if (id === 's-f-devotional')  renderFDevotional();
  if (id === 's-f-modcomp')     renderFModComp();
  if (id === 's-add-credit')    renderFPointsGrid();
  if (id === 's-f-points-grid-detail' && pointsGridCurrentStudent) renderPointsGridChecklist(pointsGridCurrentStudent);
  if (id === 's-admin-home')    updateAdminHomeStats();
  if (id === 's-a-student-att') renderAStudentAtt();
  if (id === 's-a-faculty-att') renderAFacultyAtt();
  if (id === 's-a-makeup')      renderMakeup();
  if (id === 's-a-dropped')     renderDroppedStudents();
  if (id === 's-a-tables')      renderATables();
  if (id === 's-a-leaderboard') switchLeaderboardTab('students');
  if (id === 's-a-devotional')  renderADevotionalTables();
  if (id === 's-a-modcomp')     renderAModCompTables();
  if (id === 's-record-home')   renderRecordStats();
  if (id === 's-r-qr')          { switchQRTab('scan'); }
  if (id === 's-r-attendance')  switchAttTab('students');
  if (id === 's-r-payment')     populatePayStudentSelect();
  if (id === 's-r-balances')    { renderBalances(); renderBalancesSummary(); }
  if (id === 's-view-tables')   renderViewTables();
  if (id === 's-lc-switch')     renderLCRoster();
  if (id === 's-lc-map')        renderLCMap();
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
const LOGIN_SCREEN_IDS = ['s-portal', 's-view-tables', 's-faculty-login', 's-admin-login', 's-record-login', 's-gs-host-login', 's-gs-buzzer-login'];

function go(id) {
  const main = document.getElementById('desktop-main');
  (main ? main.querySelectorAll('.screen') : document.querySelectorAll('.screen'))
    .forEach(s => { s.classList.remove('active'); s.classList.remove('screen-animated'); });
  const el = document.getElementById(id);
  if (el) { el.classList.add('screen-animated'); el.classList.add('active'); }
  APP.currentScreen = id;

  // Going back to the portal landing screen ends any Add Student session
  // right away, even if the 5-minute window hasn't run out yet.
  if (id === 's-portal') endAddStudentSession();

  const refreshBtn = document.getElementById('global-refresh-btn');
  if (refreshBtn) refreshBtn.classList.toggle('is-hidden', LOGIN_SCREEN_IDS.includes(id));

  if (id === 's-faculty-home')  updateFacultyHome();
  if (id === 's-f-lessons')     renderWeeks('f');
  if (id === 's-f-students')    renderFStudents();
  if (id === 's-f-payment')     renderFPayment();
  if (id === 's-f-credits')     renderFCredits();
  if (id === 's-f-devotional')  renderFDevotional();
  if (id === 's-f-modcomp')     renderFModComp();
  if (id === 's-add-credit')    renderFPointsGrid();
  if (id === 's-f-points-grid-detail' && pointsGridCurrentStudent) renderPointsGridChecklist(pointsGridCurrentStudent);
  if (id === 's-admin-home')    updateAdminHomeStats();
  if (id === 's-a-student-att') renderAStudentAtt();
  if (id === 's-a-faculty-att') renderAFacultyAtt();
  if (id === 's-a-makeup')      renderMakeup();
  if (id === 's-a-dropped')     renderDroppedStudents();
  if (id === 's-a-tables')      renderATables();
  if (id === 's-a-leaderboard') switchLeaderboardTab('students');
  if (id === 's-a-devotional')  renderADevotionalTables();
  if (id === 's-a-modcomp')     renderAModCompTables();
  if (id === 's-record-home')   renderRecordStats();
  if (id === 's-r-qr')          { switchQRTab('scan'); }
  if (id === 's-r-attendance')  switchAttTab('students');
  if (id === 's-r-payment')     populatePayStudentSelect();
  if (id === 's-r-balances')    { renderBalances(); renderBalancesSummary(); }
  if (id === 's-add-credit')   populateCreditStudentSelect();
  if (id === 's-view-tables')  renderViewTables();
  if (id === 's-lc-switch')    renderLCRoster();
  if (id === 's-lc-map')       renderLCMap();
}

// Manually re-syncs all data from the sheet and re-renders whatever screen
// is currently open — no page reload, so the person stays logged in.
async function refreshApp() {
  const btn = document.getElementById('global-refresh-btn');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  try {
    await loadAllData();
    showToast('✅ Data refreshed');
  } catch (err) {
    showToast('❌ Refresh failed — check connection');
    console.error('refreshApp error:', err);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

// ═══════════════════════════════════════════
// WEEK LESSONS
// ═══════════════════════════════════════════
function renderWeeks(prefix) {
  const grid = document.getElementById(`week-grid-${prefix}`);
  if (!grid) return;
  if (!APP.lessons.length) {
    grid.innerHTML = '<p style="padding:16px;color:var(--gray)">No lessons found.</p>';
    return;
  }
  grid.innerHTML = APP.lessons.map(l => `
    <div class="week-card" style="cursor:pointer;border:1.5px solid var(--border);border-radius:12px;padding:14px;background:#fff;transition:box-shadow 0.15s" onclick="showLessonDetail(${l['Week No']},'${prefix}')" onmouseover="this.style.boxShadow='0 2px 12px rgba(0,0,0,0.10)'" onmouseout="this.style.boxShadow='none'">
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:2px">WEEK ${l["Week No"]}</div>
      <strong style="font-size:14px;color:var(--text1)">${l["Lesson Title"] || ""}</strong>
      <div style="margin-top:6px;font-size:11px;color:var(--text3)">${l["Status"] || ""}</div>
    </div>
  `).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Turns the raw multi-line "Lesson Content" cell text (exactly as typed/arranged
// in Google Sheets, with blank-line paragraph breaks and "1. ITEM — description"
// style numbered points) into properly structured, styled HTML.
function formatLessonContent(raw) {
  if (!raw || !String(raw).trim()) {
    return '<span style="color:var(--text3)">No content added yet.</span>';
  }

  const text = String(raw).replace(/\r\n/g, '\n').trim();
  const blocks = text.split(/\n\s*\n/); // paragraphs = blank-line separated chunks
  let html = '';

  blocks.forEach(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;

    const isNumberedList = lines.length > 1 && lines.every(l => /^\d+\.\s*/.test(l));

    if (isNumberedList) {
      html += '<div class="lc-list">';
      lines.forEach(line => {
        const m = line.match(/^(\d+)\.\s*(.+)$/);
        const num = m[1];
        const rest = m[2];
        const dashMatch = rest.match(/^(.*?)\s*[—–-]\s*(.+)$/);
        const label = dashMatch ? dashMatch[1].trim() : rest.trim();
        const desc  = dashMatch ? dashMatch[2].trim() : '';
        html += `<div class="lc-list-item">
          <span class="lc-num">${num}.</span>
          <span class="lc-item-body"><strong>${escapeHtml(label)}</strong>${desc ? ' — ' + escapeHtml(desc) : ''}</span>
        </div>`;
      });
      html += '</div>';
      return;
    }

    if (lines.length === 1) {
      const letters = lines[0].replace(/[^A-Za-z]/g, '');
      const isHeading = letters.length > 3 && letters === letters.toUpperCase();
      if (isHeading) {
        html += `<div class="lc-heading">${escapeHtml(lines[0])}</div>`;
        return;
      }
    }

    html += `<p class="lc-para">${lines.map(escapeHtml).join('<br>')}</p>`;
  });

  return html || `<p class="lc-para">${escapeHtml(text)}</p>`;
}

function showLessonDetail(weekNo, prefix) {
  const lesson = APP.lessons.find(l => String(l["Week No"]) === String(weekNo));
  if (!lesson) return;

  const titleEl = document.getElementById('lesson-detail-title');
  const bodyEl  = document.getElementById('lesson-detail-body');

  if (titleEl) titleEl.textContent = `Week ${lesson["Week No"]}`;
  if (bodyEl) bodyEl.innerHTML = `
    <div class="card" style="margin-bottom:12px;background:linear-gradient(135deg,var(--navy),var(--navy-light));padding:18px">
      <div style="font-size:11px;color:rgba(255,255,255,0.65);font-weight:600;margin-bottom:4px">LESSON TITLE</div>
      <div style="font-size:18px;font-weight:700;color:#fff;font-family:var(--font-head)">${lesson["Lesson Title"] || "—"}</div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:18px">
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:8px">LESSON CONTENT</div>
      <div class="lc-content">${formatLessonContent(lesson["Lesson Content"])}</div>
    </div>
    <div style="display:flex;gap:10px">
      <div class="card" style="flex:1;padding:14px;text-align:center">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">DATE RELEASED</div>
        <div style="font-size:13px;font-weight:600;color:var(--text1)">${lesson["Date Released"] ? new Date(lesson["Date Released"]).toLocaleDateString() : "—"}</div>
      </div>
      <div class="card" style="flex:1;padding:14px;text-align:center">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">STATUS</div>
        <div style="font-size:13px;font-weight:600;color:${lesson["Status"] === "Released" ? "var(--green)" : "var(--text3)"}">${lesson["Status"] || "—"}</div>
      </div>
    </div>
  `;

  APP._lessonDetailPrefix = prefix;
  go('s-f-lesson-detail');
}

// ═══════════════════════════════════════════
// FACULTY — ATTENDANCE LIST (renamed from Students)
// ═══════════════════════════════════════════
function renderFStudents() {
  const list = document.getElementById('f-students-list');
  if (!list) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const week = document.getElementById('f-week-filter')?.value || APP.currentWeek;
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    list.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }

  const statusColors = {
    present: { bg: '#e8f5ee', color: '#46586e', label: 'Present' },
    late:    { bg: '#fff5e0', color: '#c9960c', label: 'Late'    },
    absent:  { bg: '#fdecea', color: '#e53935', label: 'Absent'  },
    none:    { bg: '#eceef1', color: '#6b7280', label: 'Not yet recorded' },
  };

  // Tally tardiness and absences for warning
  list.innerHTML = filtered.map(s => {
    const att = APP.attendance.find(a =>
      String(a["Student ID"]) === String(s["Student ID"]) &&
      String(a["Week No"]) === String(week)
    );

    // IMPORTANT: no attendance row at all (never scanned, not marked absent)
    // must NOT be displayed as "Absent" — that's a real, distinct status
    // someone explicitly recorded. Missing data just means nothing has
    // happened yet for this student/week.
    let key;
    if (!att) {
      key = "none";
    } else {
      const rawStatus = (att["Attendance Status"] || att["Status"] || "present").toLowerCase();
      key = rawStatus.includes("late") ? "late" : rawStatus.includes("absent") ? "absent" : "present";
    }
    const { bg, color, label } = statusColors[key];

    // Count totals for warnings
    const allAtt = APP.attendance.filter(a => String(a["Student ID"]) === String(s["Student ID"]));
    const totalLate = allAtt.filter(a => (a["Attendance Status"]||a["Status"]||"").toLowerCase().includes("late")).length;
    const totalAbsent = allAtt.filter(a => (a["Attendance Status"]||a["Status"]||"").toLowerCase().includes("absent")).length;
    const warningHtml = totalAbsent >= 2 ? `<div style="font-size:10px;color:#e53935;margin-top:2px">⚠️ ${totalAbsent} absences${totalAbsent >= 3 ? ' — DROP RISK' : ''}</div>` :
                        totalLate >= 2 ? `<div style="font-size:10px;color:#c9960c;margin-top:2px">⏰ ${totalLate} tardiness${totalLate >= 3 ? ' = 1 Absent' : ''}</div>` : '';

    return `
      <div class="row" style="align-items:center">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>${getTableLabel(s["Table No"])} · Week ${week}</small>
          ${warningHtml}
        </div>
        <div style="background:${bg};color:${color};font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;white-space:nowrap">${label}</div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// FACULTY — DEVOTIONAL & ACTIVITIES (Student List)
// ═══════════════════════════════════════════
let devotActCurrentStudent = null;

function renderFDevotional() {
  const el = document.getElementById('f-devotional-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }
  el.innerHTML = filtered.map(s => {
    const devotDone = getDevotionalCount(s["Student ID"]);
    const devotPct  = Math.round((devotDone / TOTAL_DEVOTIONAL_DAYS) * 100);
    const eligible  = isDevotionalCertificateEligible(s["Student ID"]);
    return `
      <button class="row" style="align-items:center;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:12px 0;border-bottom:1px solid #f0f0f0" onclick="openDevotActDetail('${s["Student ID"]}')">
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px">${s["Full Name"]} ${eligible ? '<span style="color:#1e7e34;font-size:11px;font-weight:700">🎓 Eligible</span>' : ''}</div>
          <div style="margin-top:4px">
            <div style="font-size:10px;color:#46586e;font-weight:600;margin-bottom:2px">📖 Devotionals ${devotDone}/${TOTAL_DEVOTIONAL_DAYS}</div>
            <div style="height:4px;background:#e0e0e0;border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${devotPct}%;background:${devotPct >= 80 ? '#46586e' : devotPct >= 50 ? '#c9960c' : '#e53935'};border-radius:4px;transition:width 0.3s"></div>
            </div>
          </div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" style="width:16px;height:16px;margin-left:10px;flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }).join('');
}

function openDevotActDetail(studentId) {
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) return;
  devotActCurrentStudent = studentId;
  const el = document.getElementById('f-devot-detail-name');
  if (el) el.textContent = student["Full Name"];
  renderDevotChecklist(studentId);
  go('s-f-devot-detail');
}

// Banner shown above the devotional checklist: progress summary, and once
// all 140 days are checked, a button to generate the Certificate of
// Appreciation. Mirrors modCompHeaderHtml's eligible-state pattern.
function devotHeaderHtml(studentId) {
  const devotDone = getDevotionalCount(studentId);
  const eligible = isDevotionalCertificateEligible(studentId);
  return `
    <div style="background:${eligible ? 'linear-gradient(135deg,#1e7e34,#3fae5c)' : 'linear-gradient(135deg,#46586e,#8fa4b8)'};border-radius:12px;padding:14px 16px;margin-bottom:14px;color:#fff">
      <div style="font-size:11px;opacity:0.85;margin-bottom:2px">20-Week Program · 140 Days</div>
      <div style="font-size:15px;font-weight:700">${eligible ? '🎓 Certificate Eligible — all devotionals Done!' : `📖 ${devotDone}/${TOTAL_DEVOTIONAL_DAYS} Devotionals Done`}</div>
      ${eligible ? `
      <button id="devot-cert-btn" class="btn-primary" style="background:#fff;color:#1e7e34;margin-top:12px" onclick="generateDevotionalCertificate('${studentId}')">
        🎓 Generate Certificate
      </button>` : ''}
    </div>`;
}

// Render the devotional checklist, grouped by Module -> Week -> 7-day row
function renderDevotChecklist(studentId) {
  const el = document.getElementById('f-devot-checklist');
  if (!el) return;
  const devotDone = APP.devotionals[studentId] || new Set();

  const counter = document.getElementById('f-devot-counter');
  if (counter) counter.textContent = `${devotDone.size}/${TOTAL_DEVOTIONAL_DAYS}`;

  let html = devotHeaderHtml(studentId);
  let lastModule = 0;
  for (let week = 1; week <= TOTAL_DEVOTIONAL_WEEKS; week++) {
    const module = Math.ceil(week / DEVOTIONAL_WEEKS_PER_MODULE);
    if (module !== lastModule) {
      html += `<div class="devot-module-head">Module ${module}</div>`;
      lastModule = module;
    }
    const startDay = (week - 1) * 7 + 1;
    let weekDone = 0;
    let dayChips = '';
    for (let i = 0; i < 7; i++) {
      const day = startDay + i;
      const checked = devotDone.has(day);
      if (checked) weekDone++;
      dayChips += `
        <label class="devot-day-chip ${checked ? 'checked' : ''}">
          <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleDevot('${studentId}', ${day}, this.checked)">
          <span>${DEVOTIONAL_DAY_NAMES[i]}</span>
        </label>`;
    }
    html += `
      <div class="devot-week-block">
        <div class="devot-week-head">
          <span class="devot-week-title">Module ${module} — Week ${week}</span>
          <span class="devot-week-count ${weekDone === 7 ? 'all-done' : ''}">${weekDone}/7</span>
        </div>
        <div class="devot-day-row">${dayChips}</div>
      </div>`;
  }

  el.innerHTML = html;
}

function toggleDevot(studentId, day, checked) {
  saveDevotional(studentId, day, checked);
  renderDevotChecklist(studentId);
  renderFDevotional();
}

// ═══════════════════════════════════════════
// ADMIN — DEVOTIONAL & ACTIVITIES RECORDS VIEW
// ═══════════════════════════════════════════
function renderADevotionalTables() {
  const el = document.getElementById('a-devot-tables');
  if (!el) return;
  const tableNos = [...new Set(APP.students.map(s => String(s["Table No"])))].filter(Boolean).sort();
  el.innerHTML = tableNos.map(tno => {
    const students = APP.students.filter(s => String(s["Table No"]) === tno && (s["Status"]||"Active").toLowerCase() !== "dropped");
    const totalS = students.length;
    const totalDevot = students.reduce((sum, s) => sum + getDevotionalCount(s["Student ID"]), 0);
    const maxPossible = totalS * TOTAL_DEVOTIONAL_DAYS;
    const devotPct = maxPossible > 0 ? Math.round((totalDevot / maxPossible) * 100) : 0;
    return `
      <button class="menu-item" onclick="openADevotTable('${tno}')" style="margin-bottom:8px">
        <div class="mi-icon" style="background:#e8f5ee"><svg viewBox="0 0 24 24" stroke="#46586e" fill="none"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg></div>
        <div class="mi-text">
          <div class="mi-title">${getTableLabel(tno)} — ${totalS} students</div>
          <div class="mi-sub">📖 ${devotPct}% devotionals</div>
        </div>
        <svg class="mi-arr" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }).join('') || '<p style="padding:16px;color:var(--gray)">No tables found.</p>';
}

function openADevotTable(tableNo) {
  const el = document.getElementById('a-devot-table-title');
  if (el) el.textContent = `${getTableLabel(tableNo)} — Devotionals`;
  renderADevotTableStudents(tableNo);
  go('s-a-devot-table');
}

function renderADevotTableStudents(tableNo) {
  const el = document.getElementById('a-devot-table-list');
  if (!el) return;
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"]||"Active").toLowerCase() !== "dropped"
  ).sort((a, b) => getDevotionalCount(b["Student ID"]) - getDevotionalCount(a["Student ID"]));

  el.innerHTML = students.map((s, i) => {
    const devotDone = getDevotionalCount(s["Student ID"]);
    const devotPct  = Math.round((devotDone / TOTAL_DEVOTIONAL_DAYS) * 100);
    return `
      <div class="row" style="align-items:flex-start;padding:12px 0;flex-direction:column">
        <div style="display:flex;align-items:center;width:100%;margin-bottom:8px">
          <div style="width:26px;height:26px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:#666;flex-shrink:0;margin-right:10px">#${i+1}</div>
          <div style="font-weight:600;font-size:14px">${s["Full Name"]}</div>
        </div>
        <div style="width:100%;padding-left:36px">
          <div style="font-size:10px;color:#46586e;font-weight:600;margin-bottom:3px">📖 Devotionals ${devotDone}/${TOTAL_DEVOTIONAL_DAYS} (${devotPct}%)</div>
          <div style="height:5px;background:#e0e0e0;border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${devotPct}%;background:#46586e;border-radius:5px"></div>
          </div>
        </div>
      </div>`;
  }).join('') || '<p style="padding:16px;color:var(--gray)">No students found.</p>';
}

// ═══════════════════════════════════════════
// FACULTY — MODULE COMPLETION (Student List)
// ═══════════════════════════════════════════
let modCompCurrentStudent = null;
let modCompActiveModule = 1; // 1 or 2

function renderFModComp() {
  const el = document.getElementById('f-modcomp-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }
  el.innerHTML = filtered.map(s => {
    const doneCount = getTotalLessonsDoneCount(s["Student ID"]);
    const makeupCount = getTotalLessonsMakeupCount(s["Student ID"]);
    const pct = Math.round((doneCount / TOTAL_LESSONS) * 100);
    const eligible = isCertificateEligible(s["Student ID"]);
    return `
      <button class="row" style="align-items:center;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:12px 0;border-bottom:1px solid #f0f0f0" onclick="openModCompDetail('${s["Student ID"]}')">
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px">${s["Full Name"]} ${eligible ? '<span style="color:#1e7e34;font-size:11px;font-weight:700">🎓 Eligible</span>' : ''}</div>
          <div style="margin-top:4px">
            <div style="font-size:10px;color:#1e3a8a;font-weight:600;margin-bottom:2px">📘 Lessons Done ${doneCount}/${TOTAL_LESSONS}${makeupCount ? ` · ⚠️ ${makeupCount} make-up` : ''}</div>
            <div style="height:5px;background:#e0e0e0;border-radius:5px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${eligible ? '#1e7e34' : pct >= 50 ? '#1e3a8a' : '#c9960c'};border-radius:5px;transition:width 0.3s"></div>
            </div>
          </div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" style="width:16px;height:16px;margin-left:10px;flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }).join('');
}

function openModCompDetail(studentId) {
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) return;
  modCompCurrentStudent = studentId;
  modCompActiveModule = 1;
  const el = document.getElementById('f-modcomp-detail-name');
  if (el) el.textContent = student["Full Name"];
  renderModCompChecklist(studentId);
  go('s-f-modcomp-detail');
}

function switchModCompModule(moduleNo) {
  modCompActiveModule = moduleNo;
  renderModCompChecklist(modCompCurrentStudent);
}

function modCompHeaderHtml(studentId) {
  const doneCount = getTotalLessonsDoneCount(studentId);
  const makeupCount = getTotalLessonsMakeupCount(studentId);
  const eligible = isCertificateEligible(studentId);
  return `
    <div style="background:${eligible ? 'linear-gradient(135deg,#1e7e34,#3fae5c)' : 'linear-gradient(135deg,#1e3a8a,#3b5fc9)'};border-radius:12px;padding:14px 16px;margin-bottom:14px;color:#fff">
      <div style="font-size:11px;opacity:0.85;margin-bottom:2px">2 Modules · 10 Lessons each · 20 total</div>
      <div style="font-size:15px;font-weight:700">${eligible ? '🎓 Certificate Eligible — all lessons Done!' : `📘 ${doneCount}/${TOTAL_LESSONS} Lessons Done${makeupCount ? ` · ⚠️ ${makeupCount} Make-up` : ''}`}</div>
      ${eligible ? `
      <button id="modcomp-cert-btn" class="btn-primary" style="background:#fff;color:#1e7e34;margin-top:12px" onclick="generateCertificate('${studentId}')">
        🎓 Generate Certificate
      </button>` : ''}
    </div>`;
}

// Renders the Module 1 / Module 2 tab switcher + the active module's 10-lesson checklist.
// Each lesson has two buttons: ✓ Done and ✗ Make-up (tap again to un-mark).
function renderModCompChecklist(studentId) {
  const el = document.getElementById('f-modcomp-checklist');
  if (!el) return;

  const counter = document.getElementById('f-modcomp-counter');
  if (counter) counter.textContent = `${getTotalLessonsDoneCount(studentId)}/${TOTAL_LESSONS} done`;

  let tabsHtml = '';
  for (let m = 1; m <= TOTAL_MODULES; m++) {
    const isActive = modCompActiveModule === m;
    const modDone = getModuleDoneCount(studentId, m);
    tabsHtml += `
      <button onclick="switchModCompModule(${m})"
        style="flex:1;padding:10px 0;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:1.5px solid ${isActive ? '#1e3a8a' : '#e8e8e8'};background:${isActive ? '#1e3a8a' : '#fff'};color:${isActive ? '#fff' : '#1e3a8a'};transition:all 0.2s">
        Module ${m}<br><span style="font-size:11px;opacity:0.85">${modDone}/${LESSONS_PER_MODULE} done</span>
      </button>`;
  }

  let lessonsHtml = '';
  for (let l = 1; l <= LESSONS_PER_MODULE; l++) {
    const status = getLessonStatus(studentId, modCompActiveModule, l);
    const isDone = status === 'Done';
    const isMakeup = status === 'Makeup';
    lessonsHtml += `
      <div data-lesson="${l}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:${isDone ? '#e8f5ee' : isMakeup ? '#fdecea' : '#fafafa'};margin-bottom:6px;border:1.5px solid ${isDone ? '#1e7e34' : isMakeup ? '#e53935' : '#e8e8e8'};transition:all 0.2s">
        <div style="flex:1">
          <span style="font-weight:600;font-size:13px">Lesson ${l}</span>
        </div>
        <button onclick="setLessonMark('${studentId}', ${modCompActiveModule}, ${l}, 'Done')"
          title="Mark Done" style="width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px;font-weight:800;border:1.5px solid ${isDone ? '#1e7e34' : '#dcdcdc'};background:${isDone ? '#1e7e34' : '#fff'};color:${isDone ? '#fff' : '#1e7e34'}">✓</button>
        <button onclick="setLessonMark('${studentId}', ${modCompActiveModule}, ${l}, 'Makeup')"
          title="Mark Make-up Class" style="width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px;font-weight:800;border:1.5px solid ${isMakeup ? '#e53935' : '#dcdcdc'};background:${isMakeup ? '#e53935' : '#fff'};color:${isMakeup ? '#fff' : '#e53935'}">✗</button>
      </div>`;
  }

  el.innerHTML = `
    ${modCompHeaderHtml(studentId)}
    <div style="display:flex;gap:8px;margin-bottom:14px">${tabsHtml}</div>
    <div id="modcomp-lesson-list">${lessonsHtml}</div>`;
}

// Tapping the same status again clears the mark (toggle off); tapping the
// other status switches straight over.
function setLessonMark(studentId, moduleNo, lessonNo, status) {
  const current = getLessonStatus(studentId, moduleNo, lessonNo);
  const next = current === status ? '' : status;
  saveLessonStatus(studentId, moduleNo, lessonNo, next);
  renderModCompChecklist(studentId);
  renderFModComp();
}

// ═══════════════════════════════════════════
// FACULTY — POINTS GRID (replaces the old manual "Add Points" form)
// Per Module → Lesson, four boxes: Attendance / Participation / Homework /
// Memory Verse. Tapping an unchecked box asks the facilitator how many
// points to give; tapping a checked box removes those points immediately.
// ═══════════════════════════════════════════
let pointsGridCurrentStudent = null;
let pointsGridActiveModule = 1;

function renderFPointsGrid() {
  const el = document.getElementById('f-points-grid-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }
  const sorted = [...filtered].sort(
    (a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"])
  );
  el.innerHTML = sorted.map((s, i) => `
    <button class="row" style="align-items:center;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:12px 0;border-bottom:1px solid #f0f0f0" onclick="openPointsGridDetail('${s["Student ID"]}')">
      <div style="flex:1">
        <div style="font-weight:600;font-size:14px">#${i + 1} ${s["Full Name"]}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${getTableLabel(s["Table No"])}</div>
      </div>
      <div style="font-size:13px;font-weight:700;color:var(--navy);white-space:nowrap;margin-right:6px">${getStudentCredits(s["Student ID"])} pts</div>
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
    </button>`).join('');
}

function openPointsGridDetail(studentId) {
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) return;
  pointsGridCurrentStudent = studentId;
  pointsGridActiveModule = 1;
  const el = document.getElementById('f-points-grid-detail-name');
  if (el) el.textContent = student["Full Name"];
  renderPointsGridChecklist(studentId);
  go('s-f-points-grid-detail');
}

function switchPointsGridModule(moduleNo) {
  pointsGridActiveModule = moduleNo;
  renderPointsGridChecklist(pointsGridCurrentStudent);
}

function renderPointsGridChecklist(studentId) {
  const el = document.getElementById('f-points-grid-checklist');
  if (!el) return;

  const counter = document.getElementById('f-points-grid-counter');
  if (counter) counter.textContent = `${getStudentCredits(studentId)} pts total`;

  let tabsHtml = '';
  for (let m = 1; m <= TOTAL_MODULES; m++) {
    const isActive = pointsGridActiveModule === m;
    tabsHtml += `
      <button onclick="switchPointsGridModule(${m})"
        style="flex:1;padding:10px 0;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:1.5px solid ${isActive ? '#1e3a8a' : '#e8e8e8'};background:${isActive ? '#1e3a8a' : '#fff'};color:${isActive ? '#fff' : '#1e3a8a'};transition:all 0.2s">
        Module ${m}
      </button>`;
  }

  let lessonsHtml = '';
  for (let l = 1; l <= LESSONS_PER_MODULE; l++) {
    const rowTotal = getLessonPointsRowTotal(studentId, pointsGridActiveModule, l);
    let boxesHtml = '';
    POINT_CATEGORIES.forEach(cat => {
      const val = getLessonPointBox(studentId, pointsGridActiveModule, l, cat.key);
      const checked = val > 0;
      boxesHtml += `
        <button onclick="handlePointsBoxTap('${studentId}', ${pointsGridActiveModule}, ${l}, '${cat.key}', '${cat.label}')"
          title="${cat.label}"
          style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 2px;border-radius:8px;cursor:pointer;border:1.5px solid ${checked ? '#1e7e34' : '#dcdcdc'};background:${checked ? '#e8f5ee' : '#fff'};color:${checked ? '#1e7e34' : '#666'}">
          <span style="font-size:15px">${checked ? '✅' : cat.icon}</span>
          <span style="font-size:9px;font-weight:700;line-height:1.2;text-align:center">${cat.label}</span>
          ${checked ? `<span style="font-size:10px;font-weight:800">${val}pt</span>` : ''}
        </button>`;
    });
    lessonsHtml += `
      <div style="padding:10px 12px;border-radius:10px;background:${rowTotal ? '#fafdff' : '#fafafa'};margin-bottom:8px;border:1.5px solid ${rowTotal ? '#c9d9f5' : '#e8e8e8'}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-weight:600;font-size:13px">Lesson ${l}</span>
          ${rowTotal ? `<span style="font-size:11px;font-weight:700;color:var(--navy)">${rowTotal} pts</span>` : ''}
        </div>
        <div style="display:flex;gap:6px">${boxesHtml}</div>
      </div>`;
  }

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px">${tabsHtml}</div>
    <div id="points-grid-lesson-list">${lessonsHtml}</div>`;
}

// Tapping a box: unchecked -> ask how many points to award; checked ->
// confirm removal (this pulls those points straight back out of the total).
function handlePointsBoxTap(studentId, moduleNo, lessonNo, categoryKey, categoryLabel) {
  const current = getLessonPointBox(studentId, moduleNo, lessonNo, categoryKey);
  if (current > 0) {
    if (!confirm(`Remove the ${current} pts already given for ${categoryLabel} (Lesson ${lessonNo})?`)) return;
    savePointsBox(studentId, moduleNo, lessonNo, categoryKey, 0);
    return;
  }
  const input = prompt(`Points to award for ${categoryLabel} — Lesson ${lessonNo}:`, '5');
  if (input === null) return;
  const points = Number(input);
  if (!Number.isFinite(points) || points <= 0) {
    showToast('⚠️ Enter a valid positive number');
    return;
  }
  savePointsBox(studentId, moduleNo, lessonNo, categoryKey, points);
}

async function savePointsBox(studentId, moduleNo, lessonNo, categoryKey, points) {
  if (!APP.lessonPoints[studentId]) APP.lessonPoints[studentId] = {};
  const key = lessonKey(moduleNo, lessonNo);
  if (!APP.lessonPoints[studentId][key]) {
    APP.lessonPoints[studentId][key] = { attendance: 0, participation: 0, homework: 0, memoryVerse: 0 };
  }
  APP.lessonPoints[studentId][key][categoryKey] = points;

  // Optimistic UI update, then sync in the background.
  renderPointsGridChecklist(studentId);
  renderFPointsGrid();

  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  try {
    await apiPost({
      action: 'toggleLessonPointBox',
      studentId,
      studentName: student?.["Full Name"] || '',
      tableNo: student?.["Table No"] || '',
      moduleNo, lessonNo,
      category: categoryKey,
      points,
      markedBy: APP.currentFaculty?.["Full Name"] || ''
    });
  } catch (e) {
    console.warn('Lesson points sync failed:', e);
    showToast('⚠️ Saved locally — will retry sync');
  }
}

// ═══════════════════════════════════════════
// ADMIN — MODULE COMPLETION RECORDS VIEW
// ═══════════════════════════════════════════
function renderAModCompTables() {
  const el = document.getElementById('a-modcomp-tables');
  if (!el) return;
  const tableNos = [...new Set(APP.students.map(s => String(s["Table No"])))].filter(Boolean).sort();
  el.innerHTML = tableNos.map(tno => {
    const students = APP.students.filter(s => String(s["Table No"]) === tno && (s["Status"]||"Active").toLowerCase() !== "dropped");
    const totalS = students.length;
    const eligibleCount = students.filter(s => isCertificateEligible(s["Student ID"])).length;
    const totalDone = students.reduce((sum, s) => sum + getTotalLessonsDoneCount(s["Student ID"]), 0);
    const maxPossible = totalS * TOTAL_LESSONS;
    const pct = maxPossible > 0 ? Math.round((totalDone / maxPossible) * 100) : 0;
    return `
      <button class="menu-item" onclick="openAModCompTable('${tno}')" style="margin-bottom:8px">
        <div class="mi-icon" style="background:#e8f0fb"><svg viewBox="0 0 24 24" stroke="#1e3a8a" fill="none"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
        <div class="mi-text">
          <div class="mi-title">${getTableLabel(tno)} — ${totalS} students</div>
          <div class="mi-sub">📘 ${pct}% lessons done · 🎓 ${eligibleCount}/${totalS} certificate-eligible</div>
        </div>
        <svg class="mi-arr" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }).join('') || '<p style="padding:16px;color:var(--gray)">No tables found.</p>';
}

function openAModCompTable(tableNo) {
  const el = document.getElementById('a-modcomp-table-title');
  if (el) el.textContent = `${getTableLabel(tableNo)} — Module Completion`;
  renderAModCompTableStudents(tableNo);
  go('s-a-modcomp-table');
}

function renderAModCompTableStudents(tableNo) {
  const el = document.getElementById('a-modcomp-table-list');
  if (!el) return;
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"]||"Active").toLowerCase() !== "dropped"
  ).sort((a, b) => getTotalLessonsDoneCount(b["Student ID"]) - getTotalLessonsDoneCount(a["Student ID"]));

  el.innerHTML = students.map((s, i) => {
    const doneCount = getTotalLessonsDoneCount(s["Student ID"]);
    const makeupCount = getTotalLessonsMakeupCount(s["Student ID"]);
    const pct = Math.round((doneCount / TOTAL_LESSONS) * 100);
    const eligible = isCertificateEligible(s["Student ID"]);
    const mod1 = getModuleDoneCount(s["Student ID"], 1);
    const mod2 = getModuleDoneCount(s["Student ID"], 2);
    return `
      <div class="row" style="align-items:flex-start;padding:12px 0;flex-direction:column">
        <div style="display:flex;align-items:center;width:100%;margin-bottom:8px">
          <div style="width:26px;height:26px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:#666;flex-shrink:0;margin-right:10px">#${i+1}</div>
          <div style="font-weight:600;font-size:14px;flex:1">${s["Full Name"]}</div>
          ${eligible ? '<span style="background:#e8f5ee;color:#1e7e34;font-size:10px;font-weight:700;border-radius:8px;padding:3px 8px">🎓 Eligible</span>' : ''}
        </div>
        <div style="width:100%;padding-left:36px">
          <div style="font-size:10px;color:#1e3a8a;font-weight:600;margin-bottom:3px">📘 Module 1: ${mod1}/${LESSONS_PER_MODULE} · Module 2: ${mod2}/${LESSONS_PER_MODULE} — ${doneCount}/${TOTAL_LESSONS} (${pct}%)${makeupCount ? ` · ⚠️ ${makeupCount} make-up` : ''}</div>
          <div style="height:5px;background:#e0e0e0;border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${eligible ? '#1e7e34' : '#1e3a8a'};border-radius:5px"></div>
          </div>
        </div>
      </div>`;
  }).join('') || '<p style="padding:16px;color:var(--gray)">No students found.</p>';
}

// ═══════════════════════════════════════════
function getStudentCredits(studentId) {
  const manualLegacy = APP.credits
    .filter(c => String(c["Student ID"]) === String(studentId))
    .reduce((sum, c) => sum + Number(c["Credits Added"] || 0), 0);
  return manualLegacy + getStudentLessonPointsTotal(studentId);
}

// ═══════════════════════════════════════════
// PAYMENT CALCULATION
// ═══════════════════════════════════════════
function getStudentPayment(studentId) {
  const payments = APP.payments.filter(p => String(p["Student ID"]) === String(studentId));
  if (!payments.length) return { paid: 0, balance: APP.totalFee, status: "Unpaid" };
  const paid = payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
  const balance = APP.totalFee - paid;
  return { paid, balance, status: balance <= 0 ? "Paid" : "Partial" };
}

// ═══════════════════════════════════════════
// FACULTY — PAYMENT LIST
// ═══════════════════════════════════════════
function renderFPayment() {
  const el = document.getElementById('f-payment-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }
  el.innerHTML = filtered.map(s => {
    const pay = getStudentPayment(s["Student ID"]);
    return `
      <div class="row">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>₱${pay.paid.toLocaleString()} paid · ₱${pay.balance.toLocaleString()} balance</small>
        </div>
        <div>${pay.status}</div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// FACULTY — CREDITS LEADERBOARD
// ═══════════════════════════════════════════
function renderFCredits() {
  const el = document.getElementById('f-credits-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const sorted = [...filtered].sort(
    (a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"])
  );
  el.innerHTML = sorted.map((s, i) => `
    <div class="row">
      <div><strong>#${i + 1} ${s["Full Name"]}</strong><br><small>${getTableLabel(s["Table No"])}</small></div>
      <div>${getStudentCredits(s["Student ID"])} pts</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No points yet.</p>';
}

// Builds the Present / Late / Absent summary bar shown at the top of an
// attendance list. `roster` is the total enrolled count for that group
// (students or faculty); anyone in the roster without a Present/Late record
// for the week counts as Absent.
function buildAttendanceSummary(weekAtt, rosterTotal) {
  const norm = a => (a["Attendance Status"] || a["Status"] || "present").toLowerCase();
  const present = weekAtt.filter(a => norm(a) === "present").length;
  const late    = weekAtt.filter(a => norm(a).includes("late")).length;
  const explicitAbsent = weekAtt.filter(a => norm(a).includes("absent")).length;
  const unaccounted = Math.max(rosterTotal - present - late - explicitAbsent, 0);
  const absent = explicitAbsent + unaccounted;

  return `
    <div class="att-summary-bar">
      <div class="att-summary-item att-summary-present">
        <div class="att-summary-num">${present}</div>
        <div class="att-summary-lbl">Present</div>
      </div>
      <div class="att-summary-item att-summary-late">
        <div class="att-summary-num">${late}</div>
        <div class="att-summary-lbl">Late</div>
      </div>
      <div class="att-summary-item att-summary-absent">
        <div class="att-summary-num">${absent}</div>
        <div class="att-summary-lbl">Absent</div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════
// ADMIN — STUDENT ATTENDANCE
// ═══════════════════════════════════════════
function renderAStudentAtt() {
  const el = document.getElementById('a-att-list');
  const week = document.getElementById('a-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.students.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No attendance records for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => `
    <div class="row">
      <div>
        <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
        <small>${getTableLabel(a["Table No"] || "—")} · ${a["LG Leader"] || ""}</small>      </div>
      <div>${a["Attendance Status"] || a["Status"] || "Present"}</div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════
// PUBLIC — VIEW TABLES (no login required)
// Reached from the "View Tables" button on the portal screen.
// Shows every table with a member count; tap a table to expand
// and see the member names + facilitator.
// ═══════════════════════════════════════════
function openViewTables() {
  go('s-view-tables');
}

function renderViewTables() {
  const list = document.getElementById('vt-list');
  if (!list) return;

  const tableMap = {};
  APP.students
    .filter(s => (s['Status'] || 'Active').toLowerCase() !== 'dropped')
    .forEach(s => {
      const t = String(s['Table No'] || '');
      if (!t) return;
      if (!tableMap[t]) tableMap[t] = [];
      tableMap[t].push(s);
    });

  const tables = Object.keys(tableMap).sort((a, b) => Number(a) - Number(b));
  if (!tables.length) {
    list.innerHTML = '<p style="padding:16px;color:var(--text3)">No table data found.</p>';
    return;
  }

  list.innerHTML = tables.map(t => {
    const students = tableMap[t].sort((a, b) => String(a['Full Name']).localeCompare(String(b['Full Name'])));
    const guide = APP.tableGuides.find(g => String(g['Table No']) === String(t));
    const facilitator = (guide && guide['Facilitator Name']) ? guide['Facilitator Name'] : 'Not assigned';
    const namesHtml = students.map(s => `<div class="vt-name-row">${s['Full Name']}</div>`).join('')
      || '<div class="vt-name-row" style="color:var(--text3)">No members yet.</div>';
    return `
      <div class="vt-card" id="vt-card-${t}">
        <div class="vt-card-head" onclick="toggleViewTable('${t}')">
          <div>
            <div class="vt-card-title">${getTableLabel(t)}</div>
            <div class="vt-card-sub">${students.length} member${students.length === 1 ? '' : 's'}</div>
          </div>
          <svg class="vt-card-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        <div class="vt-card-body">
          <div class="vt-card-fac">Facilitator: <strong>${facilitator}</strong></div>
          ${namesHtml}
        </div>
      </div>
    `;
  }).join('');
}

function toggleViewTable(tableNo) {
  const card = document.getElementById(`vt-card-${tableNo}`);
  if (card) card.classList.toggle('open');
}

// ═══════════════════════════════════════════
// ADMIN — TABLES VIEW
// ═══════════════════════════════════════════
function renderATables() {
  const grid = document.getElementById('a-table-grid');
  const week = document.getElementById('a-table-week')?.value || APP.currentWeek;
  if (!grid) return;

  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  const tableMap = {};
  APP.students.forEach(s => {
    const t = String(s["Table No"]);
    if (!tableMap[t]) tableMap[t] = { students: [], present: 0 };
    tableMap[t].students.push(s);
  });
  weekAtt.forEach(a => {
    const t = String(a["Table No"]);
    if (tableMap[t]) tableMap[t].present++;
  });

  const tables = Object.keys(tableMap).sort((a, b) => Number(a) - Number(b));
  if (!tables.length) {
    grid.innerHTML = '<p style="padding:16px;color:var(--gray)">No table data found.</p>';
    return;
  }
  grid.innerHTML = tables.map(t => {
    const totalLC = getTableCredits(t);
    return `
      <div class="card" style="padding:14px;cursor:pointer" onclick="showTableDetail('${t}')">
        <div style="font-family:var(--font-head);font-size:18px;font-weight:700">${getTableLabel(t)}</div>
        <div style="font-size:12px;color:var(--gray);margin-top:4px">${totalLC} pts</div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// ADMIN — TABLE DETAIL
// ═══════════════════════════════════════════
function showTableDetail(tableNo) {
  go('s-a-table-detail');
  // Store current table so refresh works
  APP._currentTableDetail = tableNo;
  const title       = document.getElementById('a-td-title');
  const stats       = document.getElementById('a-td-stats');
  const presentStat = document.getElementById('a-td-present-stat');
  const list        = document.getElementById('a-td-list');
  if (title) title.textContent = getTableLabel(tableNo);

  // Only active (non-dropped) students
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const presentThisWeek = APP.attendance.filter(a =>
    String(a["Table No"]) === String(tableNo) && String(a["Week No"]) === String(APP.currentWeek)
  );
  // Table-level credits only (not individual student sum)
  const tableCredits = getTableCredits(tableNo);

  if (presentStat) presentStat.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,var(--green),var(--green-light));border-radius:12px;padding:14px 18px;margin-bottom:12px">
      <div style="font-size:28px;font-family:var(--font-head);font-weight:700;color:#fff">${presentThisWeek.length}<span style="font-size:14px;font-weight:500;opacity:0.7">/${students.length}</span></div>
      <div style="color:rgba(255,255,255,0.85);font-size:13px;font-weight:600">Present — Week ${APP.currentWeek}</div>
    </div>
  `;

  if (stats) stats.innerHTML = `
    <div class="stat-card"><div class="stat-val">${students.length}</div><div class="stat-label">Students</div></div>
    <div class="stat-card"><div class="stat-val">${tableCredits}</div><div class="stat-label">Table Points</div></div>
  `;

  const sorted = [...students].sort((a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"]));
  if (list) list.innerHTML = sorted.map(s => `
    <div class="row">
      <div><strong>${s["Full Name"]}</strong></div>
      <div>${getStudentCredits(s["Student ID"])} pts</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No students in this table.</p>';
}

async function confirmDropStudentFromTable(studentId, studentName) {
  if (!confirm(`Drop ${studentName}? This will remove them from active student lists.`)) return;
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Student not found'); return; }
  try {
    await apiPost({
      action: "updateStudentStatus",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      status: "Dropped"
    });
    student["Status"] = "Dropped";
    showToast(`✅ ${student["Full Name"]} marked as Dropped`);
    renderDroppedStudents();
    updateAdminHomeStats();
    populateCreditStudentSelect();
    // Refresh table detail in place
    showTableDetail(APP._currentTableDetail);
  } catch (err) {
    console.error('confirmDropStudentFromTable error:', err);
    showToast('❌ Failed to update status');
  }
}

// Get total LC credits for a whole table — table-level only (studentId is blank)
function getTableCredits(tableNo) {
  return APP.credits
    .filter(c => String(c["Table No"]) === String(tableNo) && (!c["Student ID"] || String(c["Student ID"]).startsWith('TABLE-')))
    .reduce((sum, c) => sum + Number(c["Credits Added"] || 0), 0);
}

// Get total LC credits for a table summing all student credits in that table
function getTableTotalStudentCredits(tableNo) {
  const students = APP.students.filter(s => String(s["Table No"]) === String(tableNo));
  return students.reduce((sum, s) => sum + getStudentCredits(s["Student ID"]), 0);
}

// ═══════════════════════════════════════════
// ADMIN — LEADERBOARD
// ═══════════════════════════════════════════
function switchLeaderboardTab(tab) {
  const studentList = document.getElementById('a-leaderboard-list');
  const tableList   = document.getElementById('a-table-leaderboard-list');
  const sBtn        = document.getElementById('lb-tab-students');
  const tBtn        = document.getElementById('lb-tab-tables');
  if (tab === 'students') {
    studentList.style.display = ''; tableList.style.display = 'none';
    sBtn.style.background = '#c9960c'; sBtn.style.color = '#fff';
    tBtn.style.background = '#fff';   tBtn.style.color = '#c9960c';
    renderLeaderboard();
  } else {
    studentList.style.display = 'none'; tableList.style.display = '';
    tBtn.style.background = '#c9960c'; tBtn.style.color = '#fff';
    sBtn.style.background = '#fff';    sBtn.style.color = '#c9960c';
    renderTableLeaderboard();
  }
}

function renderLeaderboard() {
  const el = document.getElementById('a-leaderboard-list');
  if (!el) return;
  const sorted = [...APP.students].sort((a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"]));
  const medals = ['🥇','🥈','🥉'];
  el.innerHTML = sorted.map((s, i) => `
    <div class="row">
      <div><strong>${medals[i] || `#${i + 1}`} ${s["Full Name"]}</strong><br><small>${getTableLabel(s["Table No"])}</small></div>
      <div>${getStudentCredits(s["Student ID"])} pts</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No students yet.</p>';
}

function renderTableLeaderboard() {
  const el = document.getElementById('a-table-leaderboard-list');
  if (!el) return;
  const tableSet = new Set(APP.students.map(s => String(s["Table No"])));
  const tableMap = {};
  tableSet.forEach(t => {
    tableMap[t] = {
      total: getTableCredits(t),
      count: APP.students.filter(s => String(s["Table No"]) === t).length
    };
  });
  const sorted = Object.keys(tableMap).sort((a, b) => tableMap[b].total - tableMap[a].total);
  const medals = ['🥇','🥈','🥉'];
  el.innerHTML = sorted.map((t, i) => `
    <div class="row">
      <div><strong>${medals[i] || `#${i + 1}`} ${getTableLabel(t)}</strong><br><small>${tableMap[t].count} students</small></div>
      <div>${tableMap[t].total} pts</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No data yet.</p>';
}

// ═══════════════════════════════════════════
// ADMIN — DROPPED STUDENTS
// ═══════════════════════════════════════════
function renderDroppedStudents() {
  const el = document.getElementById('a-dropped-list');
  if (!el) return;
  const dropped = APP.students.filter(s =>
    (s["Status"] || "").toLowerCase() === "dropped"
  );
  if (!dropped.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No dropped students found.</p>';
    return;
  }

  // Group by table
  const byTable = {};
  dropped.forEach(s => {
    const t = String(s["Table No"] || "—");
    if (!byTable[t]) byTable[t] = [];
    byTable[t].push(s);
  });

  const tables = Object.keys(byTable).sort((a, b) => Number(a) - Number(b));
  el.innerHTML = tables.map(t => `
    <div style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);letter-spacing:0.05em;padding:10px 16px 4px">TABLE ${t}</div>
      ${byTable[t].map(s => {
        // Count absences for this student
        const absenceCount = APP.attendance.filter(a =>
          String(a['Student ID']) === String(s['Student ID']) &&
          (a['Attendance Status'] || a['Status'] || '').toLowerCase().includes('absent')
        ).length;
        return `
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);background:#fff">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--text1)">${s["Full Name"]}</div>
              <div style="font-size:12px;color:var(--text3)">${s["LG Leader"] || "—"} · ${getTableLabel(t)}</div>
              <div style="font-size:11px;color:#e53935;margin-top:2px;font-weight:600">🚫 DROPPED — ${absenceCount} absence${absenceCount !== 1 ? 's' : ''}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="handleDropDecision('${s["Student ID"]}','${s["Full Name"].replace(/'/g,"\\'")}','drop')"
              style="flex:1;padding:8px;border-radius:8px;border:1.5px solid #e53935;background:#fdecea;color:#e53935;font-size:12px;font-weight:700;cursor:pointer">
              🗑 Drop (no excuse)
            </button>
            <button onclick="handleDropDecision('${s["Student ID"]}','${s["Full Name"].replace(/'/g,"\\'")}','continue')"
              style="flex:1;padding:8px;border-radius:8px;border:1.5px solid #27ae60;background:#e8f5ee;color:#27ae60;font-size:12px;font-weight:700;cursor:pointer">
              ✅ Continue (valid excuse)
            </button>
          </div>
        </div>
      `}).join('')}
    </div>
  `).join('');
}

async function handleDropDecision(studentId, studentName, decision) {
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  if (!student) return;

  if (decision === 'drop') {
    if (!confirm(`Confirm DROP for ${studentName}?\n\nNo valid excuse — this student will remain dropped and their QR code will stay disabled.`)) return;
    // Already dropped — just confirm and keep as-is (status stays "Dropped")
    showToast(`🗑 ${studentName} confirmed Dropped`);
    renderDroppedStudents();

  } else if (decision === 'continue') {
    const excuse = prompt(`Allow ${studentName} to CONTINUE?\n\nEnter the valid excuse / reason (required):`);
    if (excuse === null) return; // cancelled
    if (!excuse.trim()) { showToast('⚠️ Excuse is required to reinstate.'); return; }
    try {
      await apiPost({
        action: 'updateStudentStatus',
        studentId: student['Student ID'],
        studentName: student['Full Name'],
        status: 'Active',
        notes: excuse.trim()
      });
      student['Status'] = 'Active';
      showToast(`✅ ${studentName} reinstated — QR re-enabled`);
      renderDroppedStudents();
      updateAdminHomeStats();
      populateCreditStudentSelect();
    } catch (err) {
      console.error('handleDropDecision error:', err);
      showToast('❌ Failed to update status');
    }
  }
}

function openDropStudentModal() {
  const modal = document.getElementById('modal-drop-student');
  if (!modal) return;
  // Reset to table picker step
  document.getElementById('drop-step-table').style.display = '';
  document.getElementById('drop-step-students').style.display = 'none';
  // Build table buttons
  const tableSet = [...new Set(
    APP.students
      .filter(s => (s["Status"] || "Active").toLowerCase() !== "dropped")
      .map(s => String(s["Table No"]))
  )].sort((a, b) => Number(a) - Number(b));
  const tableGrid = document.getElementById('drop-table-grid');
  if (tableGrid) {
    tableGrid.innerHTML = tableSet.map(t => `
      <button onclick="selectDropTable('${t}')" style="padding:14px;border-radius:10px;border:1.5px solid var(--border);background:#fff;font-size:15px;font-weight:700;cursor:pointer;color:var(--text1)">${getTableLabel(t)}</button>
    `).join('');
  }
  modal.style.display = 'flex';
}

function selectDropTable(tableNo) {
  document.getElementById('drop-step-table').style.display = 'none';
  document.getElementById('drop-step-students').style.display = '';
  document.getElementById('drop-step-table-label').textContent = `${getTableLabel(tableNo)} — Select Student`;
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const list = document.getElementById('drop-student-list');
  if (!list) return;
  if (!students.length) {
    list.innerHTML = '<p style="padding:12px;color:var(--gray);text-align:center">No active students in this table.</p>';
    return;
  }
  list.innerHTML = students.map(s => `
    <div onclick="confirmDropStudent('${s["Student ID"]}', '${s["Full Name"].replace(/'/g, "\\'")}')"
      style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer">
      <div style="font-size:14px;font-weight:600;color:var(--text1)">${s["Full Name"]}</div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red,#e53935)" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

async function confirmDropStudent(studentId, studentName) {
  if (!confirm(`Drop ${studentName}? This will remove them from active student lists.`)) return;
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Student not found'); return; }
  try {
    await apiPost({
      action: "updateStudentStatus",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      status: "Dropped"
    });
    student["Status"] = "Dropped";
    showToast(`✅ ${student["Full Name"]} marked as Dropped`);
    closeDropStudentModal();
    renderDroppedStudents();
    updateAdminHomeStats();
  } catch (err) {
    console.error('confirmDropStudent error:', err);
    showToast('❌ Failed to update status');
  }
}

function closeDropStudentModal() {
  const modal = document.getElementById('modal-drop-student');
  if (modal) modal.style.display = 'none';
}


// ═══════════════════════════════════════════
// QR SCANNER
// ═══════════════════════════════════════════
let html5QrScanner = null;
let qrScanCooldown = false;

// ═══════════════════════════════════════════
// QR TAB SWITCHER
// ═══════════════════════════════════════════
function switchQRTab(tab) {
  const scanPanel = document.getElementById('qr-panel-scan');
  const genPanel  = document.getElementById('qr-panel-gen');
  const scanBtn   = document.getElementById('qr-tab-scan');
  const genBtn    = document.getElementById('qr-tab-gen');
  if (tab === 'scan') {
    scanPanel.style.display = ''; genPanel.style.display = 'none';
    scanBtn.style.background = 'var(--purple)'; scanBtn.style.color = '#fff';
    genBtn.style.background  = '#fff';           genBtn.style.color  = 'var(--purple)';
  } else {
    scanPanel.style.display = 'none'; genPanel.style.display = '';
    genBtn.style.background  = 'var(--purple)'; genBtn.style.color  = '#fff';
    scanBtn.style.background = '#fff';           scanBtn.style.color = 'var(--purple)';
    stopQRCamera();
    renderQRGenList();
  }
}

// ═══════════════════════════════════════════
// QR SCANNER — with live status indicator
// ═══════════════════════════════════════════
function setScanStatus(state, msg) {
  // state: 'idle' | 'scanning' | 'success' | 'error'
  const bar = document.getElementById('qr-status-bar');
  if (!bar) return;
  const colors = { idle:'#6b7280', scanning:'#7c3aed', success:'#46586e', error:'#e53935' };
  const icons  = { idle:'📷', scanning:'🔍', success:'✅', error:'⚠️' };
  bar.style.display = msg ? '' : 'none';
  bar.style.background = colors[state] || colors.idle;
  bar.innerHTML = `<span style="font-size:15px">${icons[state]||''}</span> <span>${msg}</span>`;
}

function startQRCamera() {
  const placeholder = document.getElementById('qr-reader-placeholder');
  const startBtn    = document.getElementById('qr-start-btn');
  const stopBtn     = document.getElementById('qr-stop-btn');
  if (placeholder) placeholder.style.display = 'none';
  if (startBtn)    startBtn.style.display = 'none';
  if (stopBtn)     stopBtn.style.display  = '';
  if (html5QrScanner) { try { html5QrScanner.stop(); } catch(e){} html5QrScanner = null; }

  setScanStatus('scanning', 'Camera starting… point at a SOL2 QR code');

  html5QrScanner = new Html5Qrcode('qr-reader');
  html5QrScanner.start(
    { facingMode: 'environment' },
    { fps: 15, qrbox: { width: 230, height: 230 }, aspectRatio: 1.0 },
    onQRCodeScanned,
    (errorMsg) => {
      // Called every frame when no QR found — only update if not in cooldown
      if (!qrScanCooldown) setScanStatus('scanning', 'Scanning… point camera at QR code');
    }
  ).then(() => {
    setScanStatus('scanning', 'Camera ready — point at a SOL2 QR code');
  }).catch(err => {
    setScanStatus('error', 'Camera error: ' + err);
    showToast('Camera error: ' + err);
    if (placeholder) placeholder.style.display = '';
    if (startBtn)    startBtn.style.display = '';
    if (stopBtn)     stopBtn.style.display  = 'none';
  });
}

function stopQRCamera() {
  if (html5QrScanner) { html5QrScanner.stop().catch(()=>{}); html5QrScanner = null; }
  const placeholder = document.getElementById('qr-reader-placeholder');
  const startBtn    = document.getElementById('qr-start-btn');
  const stopBtn     = document.getElementById('qr-stop-btn');
  const reader      = document.getElementById('qr-reader');
  if (placeholder) placeholder.style.display = '';
  if (startBtn)    startBtn.style.display = '';
  if (stopBtn)     stopBtn.style.display  = 'none';
  if (reader)      reader.innerHTML = '';
  setScanStatus('idle', '');
}

async function onQRCodeScanned(decodedText) {
  if (qrScanCooldown) return;
  qrScanCooldown = true;

  // Flash green on the scanner box
  const scanBox = document.querySelector('.qr-scan-box');
  if (scanBox) {
    scanBox.style.outline = '4px solid #4ade80';
    setTimeout(() => { scanBox.style.outline = ''; }, 600);
  }

  if (!decodedText.startsWith(QR_PREFIX)) {
    setScanStatus('error', 'Invalid QR — only SOL2 QR codes accepted');
    const resultEl = document.getElementById('qr-result');
    if (resultEl) resultEl.innerHTML = `
      <div style="background:#fff3cd;padding:14px 16px;border-radius:12px;border-left:4px solid #e8a020;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:20px">⚠️</span>
        <div><strong>Invalid QR Code</strong><br><span style="font-size:12px;color:#666">Only SOL2 QR codes are accepted. Try the QR Generator tab to create one.</span></div>
      </div>`;
    showToast('⚠️ Not a SOL2 QR code');
    setTimeout(() => {
      qrScanCooldown = false;
      setScanStatus('scanning', 'Scanning… point camera at QR code');
    }, 3000);
    return;
  }

  const personId = decodedText.slice(QR_PREFIX.length);
  const student  = APP.students.find(s => String(s['Student ID']) === String(personId));
  if (student) { await scanQR(student['Student ID']); setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Ready — scan next'); }, 3000); return; }
  const faculty  = APP.faculty.find(f => String(f['Faculty ID']) === String(personId));
  if (faculty)  { await scanFacultyQR(faculty['Faculty ID']); setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Ready — scan next'); }, 3000); return; }

  setScanStatus('error', 'QR not recognised — ID: ' + personId);
  showToast('QR not recognised: ' + personId);
  setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Scanning…'); }, 3000);
}

async function scanQR(id) {
  const student = APP.students.find(s => String(s['Student ID']) === String(id));
  if (!student) return;

  // ── Block dropped students ──────────────────────────────────────────────
  const studentStatus = (student['Status'] || 'Active').toLowerCase();
  if (studentStatus === 'dropped') {
    setScanStatus('error', student['Full Name'] + ' — DROPPED (QR disabled)');
    const resultEl = document.getElementById('qr-result');
    if (resultEl) resultEl.innerHTML = `
      <div style="background:#fdecea;padding:14px 16px;border-radius:12px;border-left:4px solid #e53935;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:28px">🚫</span>
        <div>
          <div style="font-weight:700;font-size:15px;color:#b71c1c">${student['Full Name']}</div>
          <div style="font-size:12px;color:#e53935;margin-top:2px">This student has been <strong>DROPPED</strong>.</div>
          <div style="font-size:11px;color:#888;margin-top:4px">Contact the director or consultant to reinstate.</div>
        </div>
      </div>`;
    showToast('🚫 ' + student['Full Name'] + ' — Dropped, QR disabled');
    return;
  }

  // ── Check if already scanned this week ────────────────────────────────
  const alreadyScanned = APP.attendance.find(a =>
    String(a['Student ID']) === String(id) &&
    String(a['Week No']) === String(APP.currentWeek)
  );
  if (alreadyScanned) {
    const prevStatus = alreadyScanned['Attendance Status'] || alreadyScanned['Status'] || 'Present';
    setScanStatus('error', student['Full Name'] + ' already recorded as ' + prevStatus + ' this week');
    const resultEl = document.getElementById('qr-result');
    if (resultEl) resultEl.innerHTML = `
      <div style="background:#fff3cd;padding:14px 16px;border-radius:12px;border-left:4px solid #e8a020;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:20px">⚠️</span>
        <div><strong>${student['Full Name']}</strong><br><span style="font-size:12px;color:#666">Already recorded as <strong>${prevStatus}</strong> for Week ${APP.currentWeek}.</span></div>
      </div>`;
    showToast('⚠️ Already scanned — ' + student['Full Name']);
    return;
  }

  const status = getAttendanceStatusByTime();
  setScanStatus('scanning', 'Saving attendance for ' + student['Full Name'] + '…');

  await apiPost({
    action:'addQRScan', qrCode:String(student['Student ID']),
    personType:'student', personId:student['Student ID'],
    name:student['Full Name'], weekNo:APP.currentWeek, scanType:'attendance'
  });
  await apiPost({
    action:'addAttendance', studentId:student['Student ID'],
    studentName:student['Full Name'], age:student['Age']||'',
    gender:student['Gender']||'', lgLeader:student['LG Leader']||'',
    networkLeader:student['Network Leader']||'', tableNo:student['Table No'],
    weekNo:APP.currentWeek, status:status, remarks:''
  });

  // ── Check absence count AFTER recording this scan ─────────────────────
  if (status === 'Absent') {
    // Count absences including the one just recorded (reload first for accuracy)
    await loadAllData();
    const totalAbsences = APP.attendance.filter(a =>
      String(a['Student ID']) === String(id) &&
      (a['Attendance Status'] || a['Status'] || '').toLowerCase().includes('absent')
    ).length;

    if (totalAbsences >= 3) {
      // Auto-drop: update status to Dropped
      await apiPost({
        action: 'updateStudentStatus',
        studentId: student['Student ID'],
        studentName: student['Full Name'],
        status: 'Dropped'
      });
      // Update local state immediately
      student['Status'] = 'Dropped';
      setScanStatus('error', student['Full Name'] + ' — AUTO-DROPPED (3 absences)');
      const resultEl = document.getElementById('qr-result');
      if (resultEl) resultEl.innerHTML = `
        <div style="background:#fdecea;padding:14px 16px;border-radius:12px;border-left:4px solid #b71c1c;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
          <span style="font-size:28px">🚫</span>
          <div>
            <div style="font-weight:700;font-size:15px;color:#b71c1c">${student['Full Name']}</div>
            <div style="font-size:13px;color:#e53935;margin-top:2px"><strong>AUTO-DROPPED</strong> — 3rd unexcused absence reached.</div>
            <div style="font-size:11px;color:#888;margin-top:4px">Director or consultant must review in admin portal.</div>
          </div>
        </div>`;
      showToast('🚫 ' + student['Full Name'] + ' AUTO-DROPPED — 3 absences');
      updateAdminHomeStats();
      return;
    }

    // Show warning if 2 absences (next = drop)
    if (totalAbsences === 2) {
      const resultEl = document.getElementById('qr-result');
      if (resultEl) resultEl.innerHTML = `
        <div style="background:#fdecea;padding:14px 16px;border-radius:12px;border-left:4px solid #e53935;margin-top:8px;display:flex;gap:10px;align-items:center">
          <span style="font-size:28px">❌</span>
          <div>
            <div style="font-weight:700;font-size:15px;color:#b71c1c">${student['Full Name']}</div>
            <div style="font-size:12px;color:#e53935">Marked <strong>Absent</strong> — Week ${APP.currentWeek} · ${getTableLabel(student['Table No'])}</div>
            <div style="font-size:12px;color:#b71c1c;font-weight:700;margin-top:4px">⚠️ WARNING: 2 absences — 1 more = AUTO-DROP</div>
          </div>
        </div>`;
      showToast('❌ ' + student['Full Name'] + ' — Absent (2nd, 1 more = Drop)');
      setTimeout(() => alert(`⚠️ WARNING\n\n${student['Full Name']} now has 2 absences.\nOne more unexcused absence will automatically DROP this student.`), 300);
      updateAdminHomeStats();
      return;
    }
  }

  // ── Normal result display ──────────────────────────────────────────────
  const alertMsg = getAttendanceAlertMessage(status);
  const statusColors = { Present: { bg:'#e8f5ee', border:'#46586e', icon:'✅' }, Late: { bg:'#fff5e0', border:'#c9960c', icon:'⏰' }, Absent: { bg:'#fdecea', border:'#e53935', icon:'❌' } };
  const sc = statusColors[status] || statusColors['Present'];

  setScanStatus(status === 'Present' ? 'success' : (status === 'Late' ? 'scanning' : 'error'), student['Full Name'] + ' — ' + status + ' ✓');
  const resultEl = document.getElementById('qr-result');
  if (resultEl) resultEl.innerHTML = `
    <div style="background:${sc.bg};padding:14px 16px;border-radius:12px;border-left:4px solid ${sc.border};margin-top:8px;display:flex;gap:10px;align-items:center">
      <span style="font-size:28px">${sc.icon}</span>
      <div>
        <div style="font-weight:700;font-size:15px;color:#1a3a2a">${student['Full Name']}</div>
        <div style="font-size:12px;color:${sc.border}">Marked <strong>${status}</strong> — Week ${APP.currentWeek} · ${getTableLabel(student['Table No'])}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">${new Date().toLocaleTimeString()}</div>
        ${status === 'Late' ? '<div style="font-size:11px;color:#c9960c;margin-top:3px">⚠️ 3 unexcused late = 1 Absent</div>' : ''}
        ${status === 'Absent' ? '<div style="font-size:11px;color:#e53935;margin-top:3px">⚠️ 3 unexcused absences = Drop</div>' : ''}
      </div>
    </div>`;

  // Show alert popup for Late/Absent
  if (status === 'Late' || status === 'Absent') {
    setTimeout(() => alert(alertMsg), 300);
  }

  showToast((status === 'Present' ? '✅' : status === 'Late' ? '⏰' : '❌') + ' ' + student['Full Name'] + ' — ' + status);
  await loadAllData();
}

async function scanFacultyQR(id) {
  const faculty = APP.faculty.find(f => String(f['Faculty ID']) === String(id));
  if (!faculty) return;
  setScanStatus('scanning', 'Saving attendance for ' + faculty['Full Name'] + '…');

  await apiPost({
    action:'addQRScan', qrCode:String(faculty['Faculty ID']),
    personType:'faculty', personId:faculty['Faculty ID'],
    name:faculty['Full Name'], weekNo:APP.currentWeek, scanType:'attendance'
  });
  await apiPost({
    action:'addFacultyAttendance', facultyId:faculty['Faculty ID'],
    facultyName:faculty['Full Name'], role:faculty['Role']||'',
    weekNo:APP.currentWeek, status:'Present'
  });

  setScanStatus('success', faculty['Full Name'] + ' (' + (faculty['Role']||'') + ') marked PRESENT ✓');
  const resultEl = document.getElementById('qr-result');
  if (resultEl) resultEl.innerHTML = `
    <div style="background:#e8f5ee;padding:14px 16px;border-radius:12px;border-left:4px solid #46586e;margin-top:8px;display:flex;gap:10px;align-items:center">
      <span style="font-size:28px">✅</span>
      <div>
        <div style="font-weight:700;font-size:15px;color:#1a3a2a">${faculty['Full Name']}</div>
        <div style="font-size:12px;color:#46586e"><strong>${faculty['Role']||'Faculty'}</strong> marked PRESENT — Week ${APP.currentWeek}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">${new Date().toLocaleTimeString()}</div>
      </div>
    </div>`;
  showToast('✅ ' + faculty['Full Name'] + ' — Present');
}

// ═══════════════════════════════════════════
// MARK UNSCANNED STUDENTS AS ABSENT
// ═══════════════════════════════════════════
async function markUnscannedAbsent() {
  const week = APP.currentWeek;

  // Students
  const activeStudents = APP.students.filter(s => (s['Status'] || 'Active').toLowerCase() !== 'dropped');
  const scannedStudentIds = new Set(
    APP.attendance
      .filter(a => String(a['Week No']) === String(week))
      .map(a => String(a['Student ID']))
  );
  const unscannedStudents = activeStudents.filter(s => !scannedStudentIds.has(String(s['Student ID'])));

  // Faculty & Staff
  const scannedFacultyIds = new Set(
    APP.facultyAttendance
      .filter(a => String(a['Week No']) === String(week))
      .map(a => String(a['Faculty ID'] || a['FacultyID']))
  );
  const unscannedFaculty = APP.faculty.filter(f => !scannedFacultyIds.has(String(f['Faculty ID'])));

  if (!unscannedStudents.length && !unscannedFaculty.length) {
    showToast('✅ Everyone already has attendance for Week ' + week);
    return;
  }

  const listLines = [
    ...unscannedStudents.map(s => '• ' + s['Full Name'] + ' (Student)'),
    ...unscannedFaculty.map(f => '• ' + f['Full Name'] + ' (Faculty/Staff)')
  ].join('\n');
  const confirmed = confirm(
    `Mark ${unscannedStudents.length} student(s) and ${unscannedFaculty.length} faculty/staff as ABSENT for Week ${week}?\n\n${listLines}`
  );
  if (!confirmed) return;

  const btn = document.getElementById('mark-absent-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  let studentCount = 0;
  for (const student of unscannedStudents) {
    try {
      await apiPost({
        action:'addAttendance', studentId:student['Student ID'],
        studentName:student['Full Name'], age:student['Age']||'',
        gender:student['Gender']||'', lgLeader:student['LG Leader']||'',
        networkLeader:student['Network Leader']||'', tableNo:student['Table No'],
        weekNo:week, status:'Absent', remarks:'Auto-marked (unscanned)'
      });
      studentCount++;
    } catch(e) { console.error('Failed to mark student absent:', student['Full Name'], e); }
  }

  let facultyCount = 0;
  for (const faculty of unscannedFaculty) {
    try {
      await apiPost({
        action:'addFacultyAttendance', facultyId:faculty['Faculty ID'],
        facultyName:faculty['Full Name'], role:faculty['Role']||'',
        weekNo:week, status:'Absent'
      });
      facultyCount++;
    } catch(e) { console.error('Failed to mark faculty absent:', faculty['Full Name'], e); }
  }

  showToast(`✅ ${studentCount} student(s) & ${facultyCount} faculty/staff marked Absent for Week ${week}`);
  if (btn) { btn.disabled = false; btn.textContent = '📋 Mark Unscanned as Absent'; }
  await loadAllData();
}


let qrGenCurrentId   = null;
let qrGenCurrentName = null;

function renderQRGenList() {
  const type   = document.getElementById('qrgen-type')?.value || 'student';
  const search = (document.getElementById('qrgen-search')?.value || '').toLowerCase();
  const list   = document.getElementById('qrgen-list');
  if (!list) return;

  const items = type === 'student'
    ? APP.students.filter(s => (s['Status']||'').toLowerCase() !== 'dropped' && (!search || s['Full Name'].toLowerCase().includes(search) || String(s['Student ID']).includes(search)))
    : APP.faculty.filter(f  => !search || f['Full Name'].toLowerCase().includes(search) || String(f['Faculty ID']).includes(search));

  if (!items.length) {
    list.innerHTML = '<p style="color:var(--text3);font-size:13px;text-align:center;padding:20px">No results found.</p>';
    return;
  }

  list.innerHTML = items.map(item => {
    const id   = type === 'student' ? item['Student ID'] : item['Faculty ID'];
    const name = item['Full Name'];
    const sub  = type === 'student' ? `ID: ${id} · ${getTableLabel(item['Table No'])}` : `ID: ${id} · ${item['Role']}`;
    const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    return `<div onclick="openQRModal('${String(id).replace(/'/g,"\'")}','${name.replace(/'/g,"\'")}','${sub.replace(/'/g,"\'")}',this)"
      style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#f8f8f8;border-radius:10px;cursor:pointer;border:1.5px solid transparent;transition:border-color 0.15s"
      onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='transparent'">
      <div style="width:38px;height:38px;background:var(--purple);border-radius:9px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0">${initials}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text1)">${name}</div>
        <div style="font-size:11px;color:var(--text3)">${sub}</div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
    </div>`;
  }).join('');
}

function openQRModal(id, name, sub) {
  qrGenCurrentId   = id;
  qrGenCurrentName = name;
  const modal = document.getElementById('qrgen-modal');
  modal.style.display = 'flex';
  document.getElementById('qrgen-modal-name').textContent = name;
  document.getElementById('qrgen-modal-id').textContent   = sub;

  // Show loading state
  const canvas = document.getElementById('qrgen-canvas');
  const qrWrap = document.getElementById('qrgen-img-wrap');

  // Use qrcode library — render into a fresh temp div then grab the img/canvas
  const tempDiv = document.createElement('div');
  tempDiv.style.position = 'absolute';
  tempDiv.style.visibility = 'hidden';
  document.body.appendChild(tempDiv);

  const qrPayload = QR_PREFIX + String(id);

  // Clear previous
  if (qrWrap) qrWrap.innerHTML = '<div style="color:#999;font-size:13px;padding:20px">Generating…</div>';

  new QRCode(tempDiv, {
    text: qrPayload,
    width: 240, height: 240,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  setTimeout(() => {
    // QRCode lib renders either canvas or img depending on browser
    const generatedCanvas = tempDiv.querySelector('canvas');
    const generatedImg    = tempDiv.querySelector('img');

    if (qrWrap) {
      if (generatedCanvas) {
        // Copy to our display canvas
        canvas.width  = generatedCanvas.width;
        canvas.height = generatedCanvas.height;
        canvas.getContext('2d').drawImage(generatedCanvas, 0, 0);
        canvas.style.display = '';
        qrWrap.innerHTML = '';
        qrWrap.appendChild(canvas);
      } else if (generatedImg) {
        // Some browsers generate an img — use it directly
        const img = document.createElement('img');
        img.src = generatedImg.src;
        img.style.cssText = 'width:240px;height:240px;border-radius:8px;display:block';
        img.onload = () => {
          // Also copy to canvas for download
          canvas.width = 240; canvas.height = 240;
          canvas.getContext('2d').drawImage(img, 0, 0, 240, 240);
        };
        qrWrap.innerHTML = '';
        qrWrap.appendChild(img);
      } else {
        qrWrap.innerHTML = '<div style="color:#e53935;font-size:13px;padding:20px">Failed to generate QR. Refresh and try again.</div>';
      }
    }

    document.body.removeChild(tempDiv);

    // Show payload for debugging
    const payloadEl = document.getElementById('qrgen-payload');
    if (payloadEl) payloadEl.textContent = 'Payload: ' + qrPayload;
  }, 200);
}

function closeQRModal() {
  document.getElementById('qrgen-modal').style.display = 'none';
}

function downloadQRCode() {
  const canvas = document.getElementById('qrgen-canvas');
  const link   = document.createElement('a');
  link.download = `SOL2_QR_${qrGenCurrentId}_${(qrGenCurrentName||'').replace(/\s+/g,'_')}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// Stop camera when navigating away
(function() {
  const _origGo = go;
  go = function(id) {
    if (id !== 's-r-qr' && html5QrScanner) stopQRCamera();
    _origGo(id);
  };
})();

// ═══════════════════════════════════════════
// ADMIN — TABLE ADD CREDIT MODAL
// ═══════════════════════════════════════════
function openTableAddCredit() {
  const modal = document.getElementById('modal-table-credit');
  if (!modal) return;
  const tableNo    = document.getElementById('a-td-title')?.textContent?.replace('Table ','').trim();
  const modalTitle = document.getElementById('modal-table-credit-title');
  if (modalTitle) modalTitle.textContent = `Add Points — ${getTableLabel(tableNo)}`;
  modal.style.display = 'flex';
  document.querySelectorAll('#modal-table-credit .reason-btn').forEach((b, i) => {
    b.classList.toggle('selected', i === 0);
  });
  APP.selectedReason = 'Attendance';
  const otherWrap = document.getElementById('modal-other-wrap');
  if (otherWrap) otherWrap.style.display = 'none';
  const otherText = document.getElementById('modal-other-text');
  if (otherText) otherText.value = '';
  const amountEl = document.getElementById('modal-credit-amount');
  if (amountEl) amountEl.value = 5;
}

function closeTableCreditModal() {
  const modal = document.getElementById('modal-table-credit');
  if (modal) modal.style.display = 'none';
}

async function doTableAddCredit() {
  const tableNo = document.getElementById('a-td-title')?.textContent?.replace('Table ','').trim();
  const amount  = Number(document.getElementById('modal-credit-amount')?.value || 5);
  const rawReason = APP.selectedReason || 'Attendance';
  const reason  = rawReason === '__other__'
    ? (document.getElementById('modal-other-text')?.value?.trim() || 'Other')
    : rawReason;

  if (!tableNo) { showToast('⚠️ Table not found'); return; }
  if (!amount || amount < 1) { showToast('⚠️ Enter a valid credit amount'); return; }

  try {
    const btn = document.getElementById('modal-add-credit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action:      'addCredit',
      studentId:   '',
      studentName: `${getTableLabel(tableNo)} (Group)`,
      tableNo:     tableNo,
      weekNo:      APP.currentWeek,
      reason,
      creditsAdded: amount,
      addedBy:     APP.currentFaculty?.["Full Name"] || 'Admin'
    });

    closeTableCreditModal();
    await loadAllData();
    showToast(`✅ ${amount} pts added to ${getTableLabel(tableNo)}`);
    showTableDetail(tableNo);
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to save'));
    console.error('doTableAddCredit error:', err);
  } finally {
    const btn = document.getElementById('modal-add-credit-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Credits to Table'; }
  }
}

// ═══════════════════════════════════════════
// ADD STUDENT (Director / Consultant / Record)
// Reached via the ➕ button on the portal screen, which first shows a
// login gate (see doAddStudentGateLogin below) — so this modal itself
// is never reachable without signing in with an Admin or Record account.
// Student ID, Status, and Registration Date are set automatically:
// the ID is generated server-side (next number after the highest
// existing "STUDENT-####"), Status is always "Active" for a new
// enrollee, and Registration Date is today.
// ═══════════════════════════════════════════
function previewNextStudentId() {
  let maxNum = 0;
  APP.students.forEach(s => {
    const m = String(s['Student ID'] || '').match(/(\d+)\s*$/);
    if (m) { const n = parseInt(m[1], 10); if (n > maxNum) maxNum = n; }
  });
  return 'STUDENT-' + String(maxNum + 1).padStart(4, '0');
}

function populateAddStudentTableSelect() {
  const sel = document.getElementById('as-tableno');
  if (!sel) return;
  const tables = [...APP.tableGuides]
    .map(g => g['Table No'])
    .filter(t => t !== '' && t !== null && t !== undefined)
    .sort((a, b) => Number(a) - Number(b));
  sel.innerHTML = '<option value="">Select…</option>' +
    tables.map(t => `<option value="${t}">${getTableLabel(t)}</option>`).join('');
}

function onAddStudentTableChange() {
  const tableNo = document.getElementById('as-tableno')?.value;
  const facEl   = document.getElementById('as-facilitator');
  if (!facEl) return;
  const guide = APP.tableGuides.find(g => String(g['Table No']) === String(tableNo));
  facEl.value = (guide && guide['Facilitator Name']) ? guide['Facilitator Name'] : '';
}

// ── Login gate ──────────────────────────────────────────────
// Shown first when the ➕ button is tapped. Only a Director/Consultant
// (admin) or Record account can pass through to the actual Add Student
// form. Once signed in, that access is remembered for a short session
// (see ADD_STUDENT_SESSION_MINUTES below) so the person isn't asked to
// log in again for every student they add — the session ends early,
// though, the moment they navigate back to the portal/home screen.
const ADD_STUDENT_SESSION_MINUTES = 5;
let addStudentSessionPerson = null;
let addStudentSessionTimer = null;

function startAddStudentSession(person) {
  addStudentSessionPerson = person;
  if (addStudentSessionTimer) clearTimeout(addStudentSessionTimer);
  addStudentSessionTimer = setTimeout(endAddStudentSession, ADD_STUDENT_SESSION_MINUTES * 60 * 1000);
}

function endAddStudentSession() {
  addStudentSessionPerson = null;
  if (addStudentSessionTimer) { clearTimeout(addStudentSessionTimer); addStudentSessionTimer = null; }
}

function hasActiveAddStudentSession() {
  return !!addStudentSessionPerson;
}

function openAddStudentGate() {
  // Already signed in within the last few minutes — skip straight to the
  // form and refresh the session clock instead of asking to log in again.
  if (hasActiveAddStudentSession()) {
    startAddStudentSession(addStudentSessionPerson); // reset the 5-min clock
    openAddStudentModal();
    return;
  }
  document.getElementById('asg-user').value = '';
  document.getElementById('asg-pass').value = '';
  hideLoginError('asg-err');
  const modal = document.getElementById('modal-add-student-gate');
  if (modal) modal.style.display = 'flex';
}

function closeAddStudentGate() {
  const modal = document.getElementById('modal-add-student-gate');
  if (modal) modal.style.display = 'none';
}

function doAddStudentGateLogin() {
  const username = document.getElementById('asg-user')?.value || '';
  const password = document.getElementById('asg-pass')?.value || '';
  const btn      = document.getElementById('asg-login-btn');
  hideLoginError('asg-err');
  if (!username || !password) { showLoginError('asg-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('asg-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) {
      showLoginError('asg-err', 'Incorrect username or password.');
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In & Continue'; }
      document.getElementById('asg-pass').value = '';
      return;
    }
    const roleTypes = getRoleTypes(person["Role"]);
    if (!roleTypes.includes('admin') && !roleTypes.includes('record')) {
      showLoginError('asg-err', 'Your account does not have Director, Consultant, or Record access.');
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In & Continue'; }
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In & Continue'; }
    startAddStudentSession(person);
    closeAddStudentGate();
    openAddStudentModal();
  }, 120);
}

function openAddStudentModal() {
  document.getElementById('as-fullname').value        = '';
  document.getElementById('as-age').value              = '';
  document.getElementById('as-gender').value           = '';
  document.getElementById('as-lgleader').value         = '';
  document.getElementById('as-networkleader').value    = '';
  document.getElementById('as-tableno').value          = '';
  document.getElementById('as-facilitator').value      = '';
  document.getElementById('as-contact').value          = '';
  const errEl = document.getElementById('as-err');
  if (errEl) errEl.style.display = 'none';

  populateAddStudentTableSelect();
  document.getElementById('as-preview-id').textContent = previewNextStudentId();
  document.getElementById('as-preview-date').textContent =
    new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const modal = document.getElementById('modal-add-student');
  if (modal) modal.style.display = 'flex';
}

function closeAddStudentModal() {
  const modal = document.getElementById('modal-add-student');
  if (modal) modal.style.display = 'none';
}

async function doAddStudent() {
  const fullName      = document.getElementById('as-fullname')?.value.trim()      || '';
  const age           = document.getElementById('as-age')?.value                  || '';
  const gender        = document.getElementById('as-gender')?.value               || '';
  const lgLeader      = document.getElementById('as-lgleader')?.value.trim()      || '';
  const networkLeader = document.getElementById('as-networkleader')?.value.trim() || '';
  const tableNo       = document.getElementById('as-tableno')?.value              || '';
  const contactNo     = document.getElementById('as-contact')?.value.trim()       || '';

  const errEl = document.getElementById('as-err');
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
  if (errEl) errEl.style.display = 'none';

  if (!fullName) { showErr('⚠️ Full Name is required.'); return; }
  if (!tableNo)  { showErr('⚠️ Please select a Table No.'); return; }

  try {
    const btn = document.getElementById('modal-add-student-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const res = await apiPost({
      action: 'addStudent',
      fullName, age, gender, lgLeader, networkLeader, tableNo, contactNo
    });

    if (!res || res.success === false) throw new Error((res && res.message) || 'Failed to add student');

    closeAddStudentModal();
    await loadAllData();
    showToast(`✅ ${fullName} added` + (res.data && res.data['Student ID'] ? ` (${res.data['Student ID']})` : ''));
    go(APP.currentScreen); // re-render whichever home screen this was opened from
  } catch (err) {
    showErr('❌ ' + (err.message || 'Failed to add student'));
    console.error('doAddStudent error:', err);
  } finally {
    const btn = document.getElementById('modal-add-student-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Student'; }
  }
}

// ═══════════════════════════════════════════
// RECORD — ATTENDANCE TAB SWITCH
// ═══════════════════════════════════════════
function switchAttTab(tab) {
  const sPanel = document.getElementById('att-panel-students');
  const fPanel = document.getElementById('att-panel-faculty');
  const sBtn   = document.getElementById('att-tab-students');
  const fBtn   = document.getElementById('att-tab-faculty');
  if (tab === 'students') {
    sPanel.style.display = ''; fPanel.style.display = 'none';
    sBtn.style.background = 'var(--purple)'; sBtn.style.color = '#fff';
    fBtn.style.background = '#fff';          fBtn.style.color = 'var(--purple)';
    renderRAttendance();
  } else {
    sPanel.style.display = 'none'; fPanel.style.display = '';
    fBtn.style.background = 'var(--purple)'; fBtn.style.color = '#fff';
    sBtn.style.background = '#fff';          sBtn.style.color = 'var(--purple)';
    renderRFacultyAtt();
  }
}

function renderRFacultyAtt() {
  const el   = document.getElementById('r-fac-att-list');
  const week = document.getElementById('r-fac-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.facultyAttendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.faculty.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No faculty attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => {
    const name     = a["Faculty Name"] || a["FacultyName"] || "—";
    const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const role     = a["Role"]   || "—";
    const status   = a["Status"] || "Present";
    const time     = formatDate(a["Scan Time"] || a["ScanTime"]);
    const badgeCls = status.toLowerCase() === 'late' ? 'ba' : 'bg';
    return `
      <div class="att-row">
        <div class="av">${initials}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">${name}</div>
          <div style="font-size:11px;color:var(--text3)">${role}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">Scanned ${time}</div>
        </div>
        <span class="badge ${badgeCls}">${status}</span>
      </div>
    `;
  }).join('');
}

function renderRAttendance() {
  const el   = document.getElementById('r-att-list');
  const week = document.getElementById('r-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.students.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => `
    <div class="row">
      <div>
        <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
        <small>${formatDate(a["Scan Time"] || a["ScanTime"])}</small>
      </div>
      <div>${a["Attendance Status"] || a["Status"] || "Present"}</div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════
// BALANCES
// ═══════════════════════════════════════════
function renderBalances() {
  const el = document.getElementById('r-bal-list');
  if (!el) return;
  if (!APP.students.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No student records.</p>';
    return;
  }
  const sorted = [...APP.students].sort((a, b) => {
    const pa = getStudentPayment(a["Student ID"]);
    const pb = getStudentPayment(b["Student ID"]);
    return pb.balance - pa.balance;
  });
  el.innerHTML = sorted.map(s => {
    const pay = getStudentPayment(s["Student ID"]);
    return `
      <div class="row">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>${getTableLabel(s["Table No"])} · ₱${pay.paid.toLocaleString()} paid</small>
        </div>
        <div style="color:${pay.balance > 0 ? 'var(--red,#e53935)' : 'var(--green)'}">
          ₱${pay.balance.toLocaleString()}
        </div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// PRINT
// ═══════════════════════════════════════════
function printAttendance() {
  // Get the currently selected week from the attendance week filter
  const weekEl = document.getElementById('a-att-week');
  const selectedWeek = weekEl ? weekEl.value : APP.currentWeek;
  const lessonInfo = APP.lessons.find(l => String(l['Week No']) === String(selectedWeek));
  const lessonLabel = lessonInfo
    ? `Lesson ${lessonInfo['Week No']}${lessonInfo['Lesson Title'] ? ' — ' + lessonInfo['Lesson Title'] : ''}`
    : `Lesson ${selectedWeek}`;

  // Filter attendance to only the selected lesson
  const filtered = APP.attendance.filter(a => String(a['Week No']) === String(selectedWeek));

  if (!filtered.length) {
    alert('No attendance records found for ' + lessonLabel);
    return;
  }

  const data = filtered.map(a => `
    <tr>
      <td>${formatDate(a["Scan Time"] || a["ScanTime"])}</td>
      <td>${a["Student Name"] || a["StudentName"] || ""}</td>
      <td>${a["Age"]            || ""}</td>
      <td>${a["Gender"]         || ""}</td>
      <td>${a["Attendance Status"] || a["Status"] || "Present"}</td>
      <td>${a["LG Leader"]      || ""}</td>
      <td>${a["Network Leader"] || ""}</td>
    </tr>
  `).join("");
  const win = window.open("", "", "width=900,height=700");
  win.document.write(`
    <html><head><title>Student Attendance — ${lessonLabel}</title>
    <style>
      @page { size: A4 portrait; margin: 20mm; }
      body { font-family: Arial, sans-serif; }
      h2 { text-align: center; margin-bottom: 4px; }
      h3 { text-align: center; margin-top: 0; margin-bottom: 20px; color: #555; font-weight: 400; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #000; padding: 6px; text-align: left; }
      th { background: #f2f2f2; }
    </style></head>
    <body>
      <h2>STUDENT ATTENDANCE REPORT — ${APP.settings["Batch Name"] || "SOL2"}</h2>
      <h3>${lessonLabel}</h3>
      <table>
        <thead><tr><th>Scan Time</th><th>Name</th><th>Age</th><th>Gender</th><th>Status</th><th>LG Leader</th><th>Network Leader</th></tr></thead>
        <tbody>${data}</tbody>
      </table>
      <script>window.print();<\/script>
    </body></html>
  `);
  win.document.close();
}

// ═══════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════
function formatDate(val) {
  if (!val) return "—";
  try { return new Date(val).toLocaleString(); } catch { return String(val); }
}

function initClock() {
  setInterval(() => {
    const el = document.getElementById('qr-live-clock');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }, 1000);
}

function updateSyncStatus(ok, msg) {
  const el  = document.getElementById('sync-label-portal');
  const dot = document.getElementById('sync-dot-portal');
  if (!el) return;
  if (ok) {
    el.textContent = 'Online · Synced';
    if (dot) { dot.style.background = '#27ae60'; dot.style.boxShadow = '0 0 0 3px rgba(39,174,96,0.25)'; }
  } else if (msg) {
    el.textContent = '⚠️ ' + msg;
    if (dot) { dot.style.background = '#e67e22'; dot.style.boxShadow = '0 0 0 3px rgba(230,126,34,0.25)'; }
  } else {
    el.textContent = 'Syncing…';
    if (dot) { dot.style.background = ''; dot.style.boxShadow = ''; }
  }
}

// ═══════════════════════════════════════════
// WEEK DROPDOWNS
// ═══════════════════════════════════════════
function populateWeekDropdowns() {
  const weekOptions = APP.lessons.map(l =>
    `<option value="${l["Week No"]}"${Number(l["Week No"]) === APP.currentWeek ? ' selected' : ''}>Lesson ${l["Week No"]}${l["Lesson Title"] ? ' – ' + l["Lesson Title"] : ''}</option>`
  ).join('');

  const fWeek = document.getElementById('f-week-filter');
  if (fWeek && weekOptions) fWeek.innerHTML = weekOptions;

  ['a-att-week', 'a-table-week', 'a-fac-att-week'].forEach(id => {
    const el = document.getElementById(id);
    if (el && weekOptions) el.innerHTML = weekOptions;
  });

  const rAtt    = document.getElementById('r-att-week');
  if (rAtt    && weekOptions) rAtt.innerHTML    = weekOptions;
  const rFacAtt = document.getElementById('r-fac-att-week');
  if (rFacAtt && weekOptions) rFacAtt.innerHTML = weekOptions;

  const mkp = document.getElementById('makeup-week');
  if (mkp && APP.lessons.length) {
    mkp.innerHTML = `<option value="0">All Weeks</option>` +
      APP.lessons.map(l => `<option value="${l["Week No"]}">Week ${l["Week No"]} absences</option>`).join('');
  }
}

// ═══════════════════════════════════════════
// ADMIN HOME STATS
// ═══════════════════════════════════════════
function updateAdminHomeStats() {
  const totalStudentsEl = document.getElementById('a-total-students');
  const totalFacultyEl  = document.getElementById('a-total-faculty');
  const totalPaidEl     = document.getElementById('a-total-paid');
  const totalDroppedEl  = document.getElementById('a-total-dropped');

  const activeStudents = APP.students.filter(s =>
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const droppedStudents = APP.students.filter(s =>
    (s["Status"] || "Active").toLowerCase() === "dropped"
  );

  if (totalStudentsEl) totalStudentsEl.textContent = activeStudents.length;
  if (totalFacultyEl)  totalFacultyEl.textContent  = APP.faculty.length;
  if (totalDroppedEl)  totalDroppedEl.textContent  = droppedStudents.length;
  if (totalPaidEl) {
    const total = APP.payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
    totalPaidEl.textContent = `₱${total.toLocaleString()}`;
  }

  const pendingMakeupCount = APP.attendance
    .filter(a => {
      const isAbsent = (a["Attendance Status"] || a["Status"] || "").toLowerCase() === "absent";
      if (!isAbsent) return false;
      const attId = a["Attendance ID"] || a["id"] || "";
      const mkStatus = (APP.makeupStatus[attId]?.status || "Pending").toLowerCase();
      return mkStatus === "pending";
    }).length;
  const badge = document.getElementById('a-makeup-badge');
  if (badge) {
    if (pendingMakeupCount > 0) { badge.textContent = `${pendingMakeupCount} pending`; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  // Dropped students badge
  const droppedCount = APP.students.filter(s =>
    (s["Status"] || "").toLowerCase() === "dropped"
  ).length;
  const droppedBadge = document.getElementById('a-dropped-badge');
  if (droppedBadge) {
    if (droppedCount > 0) { droppedBadge.textContent = `${droppedCount}`; droppedBadge.style.display = ''; }
    else { droppedBadge.style.display = 'none'; }
  }
}

// ═══════════════════════════════════════════
// FACULTY HOME
// ═══════════════════════════════════════════
function updateFacultyHome() {
  const nameEl = document.getElementById('f-home-name');
  const roleEl = document.getElementById('f-home-role');
  const f = APP.currentFaculty || APP.faculty[0];
  if (!f) return;
  if (nameEl) nameEl.textContent = f["Full Name"] || "—";
  if (roleEl) roleEl.textContent = `${f["Role"] || ""}${f["Table Assigned"] ? ' · Table ' + f["Table Assigned"] : ''}`;

  const tableNo = f["Table Assigned"] || "";
  ['f-students-topbar','f-payment-topbar','f-credits-topbar'].forEach(id => {
    const el = document.getElementById(id);
    if (el && tableNo) {
      const labels = { 'f-students-topbar': 'Attendance', 'f-payment-topbar': 'Payment', 'f-credits-topbar': 'Points' };
      el.textContent = `${getTableLabel(tableNo)} — ${labels[id]}`;
    }
  });
}

// ═══════════════════════════════════════════
// ADMIN — FACULTY ATTENDANCE
// ═══════════════════════════════════════════
function renderAFacultyAtt() {
  const el   = document.getElementById('a-fac-att-list');
  const week = document.getElementById('a-fac-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.facultyAttendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.faculty.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No faculty attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => {
    const name     = a["Faculty Name"] || a["FacultyName"] || "—";
    const initials = name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const role     = a["Role"]   || "—";
    const status   = a["Status"] || "Present";
    const time     = formatDate(a["Scan Time"] || a["ScanTime"]);
    const badgeCls = status.toLowerCase() === 'late' ? 'ba' : 'bg';
    return `
      <div class="att-row">
        <div class="av">${initials}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">${name}</div>
          <div style="font-size:11px;color:var(--text3)">${role}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">Scanned ${time}</div>
        </div>
        <span class="badge ${badgeCls}">${status}</span>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// ADMIN — MAKEUP LESSONS
// ═══════════════════════════════════════════
function renderMakeup() {
  const el   = document.getElementById('makeup-list');
  const week = document.getElementById('makeup-week')?.value || "0";
  if (!el) return;
  let absences = APP.attendance.filter(a =>
    (a["Attendance Status"] || a["Status"] || "").toLowerCase() === "absent"
  );
  if (week !== "0") absences = absences.filter(a => String(a["Week No"]) === String(week));
  if (!absences.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No absences found.</p>';
    return;
  }

  const statusColors = {
    'Pending':   { bg: '#fdecea', color: '#e53935' },
    'Scheduled': { bg: '#fff5e0', color: '#c9960c' },
    'Done':      { bg: '#e8f5ee', color: '#46586e' }
  };

  el.innerHTML = absences.map(a => {
    const attId = String(a["Attendance ID"] || '');
    const mkStatus = (APP.makeupStatus[attId]?.status) || 'Pending';
    const { bg, color } = statusColors[mkStatus] || statusColors['Pending'];
    return `
      <div class="row" style="align-items:center;flex-wrap:wrap;gap:6px;padding:12px 0">
        <div style="flex:1;min-width:120px">
          <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
          <small style="color:var(--text3)">Week ${a["Week No"]} · ${getTableLabel(a["Table No"] || "—")}</small>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <div style="background:${bg};color:${color};font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;white-space:nowrap">${mkStatus}</div>
          <select onchange="doUpdateMakeupStatus('${attId}', this.value, '${a["Student ID"] || ""}', '${(a["Student Name"]||"").replace(/'/g,"\\'")}', ${a["Week No"] || 0}, '${a["Table No"] || ""}')"
            style="font-size:11px;padding:4px 8px;border:1.5px solid ${color};border-radius:8px;background:#fff;color:${color};font-weight:600;cursor:pointer">
            <option value="Pending"   ${mkStatus === 'Pending'   ? 'selected' : ''}>Pending</option>
            <option value="Scheduled" ${mkStatus === 'Scheduled' ? 'selected' : ''}>Scheduled</option>
            <option value="Done"      ${mkStatus === 'Done'      ? 'selected' : ''}>Done</option>
          </select>
        </div>
      </div>`;
  }).join('');
}

async function doUpdateMakeupStatus(attendanceId, status, studentId, studentName, weekNo, tableNo) {
  if (!attendanceId) { showToast('⚠️ Cannot update — no attendance ID.'); return; }
  showToast('⏳ Updating makeup status...');
  await saveMakeupStatus(attendanceId, status, studentId, studentName, weekNo, tableNo, '');
  renderMakeup();
  showToast(`✅ Makeup status set to ${status}`);
}



// ═══════════════════════════════════════════
// RECORD HOME STATS
// ═══════════════════════════════════════════
function renderRecordStats() {
  const el = document.getElementById('r-stats');
  if (!el) return;
  const activeStudents = APP.students.filter(s => (s["Status"] || "Active").toLowerCase() !== "dropped");
  const totalPaid = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Paid").length;
  const totalPaymentsAmount = APP.payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
  const totalUnpaid = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Unpaid").length;
  el.innerHTML = `
    <div class="stat-card"><div class="stat-val">${activeStudents.length}</div><div class="stat-label">Total Students</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--green)">${totalPaid}</div><div class="stat-label">Fully Paid</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#3a4250">₱${totalPaymentsAmount.toLocaleString()}</div><div class="stat-label">Total Collected</div></div>
    <div class="stat-card"><div class="stat-val" style="color:${totalUnpaid > 0 ? '#e53935' : 'var(--green)'}">${totalUnpaid}</div><div class="stat-label">Unpaid</div></div>
  `;
}

// ═══════════════════════════════════════════
// RECORD — PAYMENT
// ═══════════════════════════════════════════
function populatePayStudentSelect() {
  const sel = document.getElementById('pay-student-sel');
  if (!sel) return;
  sel.innerHTML = APP.students.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]} (${getTableLabel(s["Table No"])})</option>`
  ).join('');
}

function filterPayStudents() {
  const query = document.getElementById('pay-search')?.value?.toLowerCase() || '';
  const sel   = document.getElementById('pay-student-sel');
  if (!sel) return;
  const filtered = APP.students.filter(s =>
    s["Full Name"].toLowerCase().includes(query) || String(s["Student ID"]).includes(query)
  );
  sel.innerHTML = filtered.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]} (${getTableLabel(s["Table No"])})</option>`
  ).join('');
}

async function doAddPayment() {
  const studentId = document.getElementById('pay-student-sel')?.value;
  const amount    = parseFloat(document.getElementById('pay-amount')?.value || 0);
  const type      = document.getElementById('pay-type')?.value || 'Full';
  const notes     = document.getElementById('pay-notes')?.value || '';

  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Please select a student.'); return; }
  if (!amount || amount <= 0) { showToast('⚠️ Enter a valid amount.'); return; }

  const pay     = getStudentPayment(student["Student ID"]);
  const balance = Math.max(0, pay.balance - amount);
  const status  = balance <= 0 ? "Paid" : "Partial";

  try {
    const btn = document.querySelector('#s-r-payment .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action:      "addPayment",
      studentId:   student["Student ID"],
      studentName: student["Full Name"],
      tableNo:     student["Table No"],
      amountPaid:  amount,
      balance:     balance,
      status:      `${status} — ${type}${notes ? ' · ' + notes : ''}`
    });

    showToast(`✅ Payment recorded for ${student["Full Name"]}`);
    document.getElementById('pay-amount').value = '';
    document.getElementById('pay-notes').value  = '';
    await loadAllData();
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to record payment'));
    console.error('doAddPayment error:', err);
  } finally {
    const btn = document.querySelector('#s-r-payment .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Record Payment'; }
  }
}

// ═══════════════════════════════════════════
// BALANCES SUMMARY
// ═══════════════════════════════════════════
function renderBalancesSummary() {
  const feeEl = document.getElementById('r-total-fee');
  if (feeEl) feeEl.textContent = `₱${APP.totalFee.toLocaleString()}.00`;

  const summaryEl = document.getElementById('r-bal-summary');
  if (!summaryEl) return;

  const activeStudents = APP.students.filter(s => (s["Status"]||"Active").toLowerCase() !== "dropped");
  const paid    = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Paid").length;
  const partial = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Partial").length;
  const unpaid  = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Unpaid").length;
  const totalCollected = APP.payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
  const totalExpected  = activeStudents.length * APP.totalFee;

  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-val" style="color:var(--green)">${paid}</div><div class="stat-label">Fully Paid</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#e8a020">${partial}</div><div class="stat-label">Partial</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--red,#e53935)">${unpaid}</div><div class="stat-label">Unpaid</div></div>
    <div class="stat-card" style="grid-column:1/-1;background:linear-gradient(135deg,#f3e8ff,#ede0f8)">
      <div class="stat-val" style="color:#3a4250">₱${totalCollected.toLocaleString()}</div>
      <div class="stat-label">Total Collected of ₱${totalExpected.toLocaleString()} expected</div>
    </div>
  `;
}

// ═══════════════════════════════════════════
// LOGIN SYSTEM
// ═══════════════════════════════════════════
const ADMIN_ROLES  = ['director', 'consultant'];
const RECORD_ROLES = ['record', 'recorder'];

// Returns ALL role types that apply to this person (a person can be e.g.
// "Consultant/Facilitator/Record" and have admin + faculty + record access).
// Falls back to ['faculty'] if nothing matches.
function getRoleTypes(role) {
  const r = (role || '').toLowerCase().trim();
  const types = [];
  if (ADMIN_ROLES.some(a  => r.includes(a))) types.push('admin');
  if (RECORD_ROLES.some(a => r.includes(a))) types.push('record');
  // "Facilitator" (or anyone not matched above) gets faculty/facilitator access
  if (r.includes('facilitator') || types.length === 0) types.push('faculty');
  return types;
}

// Kept for any other call sites — returns the single highest-priority role
// (admin > record > faculty). Prefer getRoleTypes().includes(x) for login gating.
function getRoleType(role) {
  const types = getRoleTypes(role);
  if (types.includes('admin'))  return 'admin';
  if (types.includes('record')) return 'record';
  return 'faculty';
}

function findFacultyByCredentials(username, password) {
  return APP.faculty.find(f =>
    String(f["Username"] || '').trim().toLowerCase() === username.trim().toLowerCase() &&
    String(f["Password"] || '').trim() === password.trim()
  ) || null;
}

function isDataEmpty() { return APP.faculty.length === 0; }

function showLoginError(errId, message) {
  const el = document.getElementById(errId);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
}

function hideLoginError(errId) {
  const el = document.getElementById(errId);
  if (el) el.style.display = 'none';
}

function setLoginLoading(btnEl, loading) {
  if (!btnEl) return;
  btnEl.disabled    = loading;
  btnEl.textContent = loading ? 'Signing in…' : 'Sign in';
}

function doFacultyLogin() {
  const username = document.getElementById('f-login-user')?.value || '';
  const password = document.getElementById('f-login-pass')?.value || '';
  const btn      = document.querySelector('#s-faculty-login .btn-primary');
  hideLoginError('f-login-err');
  if (!username || !password) { showLoginError('f-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('f-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('f-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('f-login-pass').value = ''; return; }
    const roleTypes = getRoleTypes(person["Role"]);
    if (!roleTypes.includes('faculty')) {
      const suggestion = roleTypes.includes('admin') ? 'Admin' : (roleTypes.includes('record') ? 'Record' : 'the correct');
      showLoginError('f-login-err', `Your account does not have Facilitator access. Use the ${suggestion} portal to sign in.`);
      setLoginLoading(btn, false);
      return;
    }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('f-login-user', 'f-login-pass');
    populateCreditStudentSelect();
    updateFacultyHome();
    go('s-faculty-home');
  }, 120);
}

function doAdminLogin() {
  const username = document.getElementById('a-login-user')?.value || '';
  const password = document.getElementById('a-login-pass')?.value || '';
  const btn      = document.querySelector('#s-admin-login .btn-primary');
  hideLoginError('a-login-err');
  if (!username || !password) { showLoginError('a-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('a-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('a-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('a-login-pass').value = ''; return; }
    const roleTypes = getRoleTypes(person["Role"]);
    if (!roleTypes.includes('admin')) { showLoginError('a-login-err', 'Your account does not have Admin access.'); setLoginLoading(btn, false); return; }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('a-login-user', 'a-login-pass');
    updateAdminHomeStats();
    go('s-admin-home');
  }, 120);
}

function doRecordLogin() {
  const username = document.getElementById('r-login-user')?.value || '';
  const password = document.getElementById('r-login-pass')?.value || '';
  const btn      = document.querySelector('#s-record-login .btn-primary');
  hideLoginError('r-login-err');
  if (!username || !password) { showLoginError('r-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('r-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('r-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('r-login-pass').value = ''; return; }
    const roleTypes = getRoleTypes(person["Role"]);
    if (!roleTypes.includes('record')) { showLoginError('r-login-err', 'Your account does not have Record access.'); setLoginLoading(btn, false); return; }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('r-login-user', 'r-login-pass');
    renderRecordStats();
    go('s-record-home');
  }, 120);
}

function logout() {
  APP.currentFaculty = null;
  go('s-portal');
}

function clearLoginFields(...ids) {
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}
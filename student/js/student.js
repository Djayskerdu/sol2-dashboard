// ╔═══════════════════════════════════════════════════════════╗
// ║  STEP 1 — PASTE THE SAME GAS WEB APP URL AS THE FACULTY APP ║
// ║  (Both apps read/write the same Google Sheet — that's how  ║
// ║  a student's quest shows up in the Faculty notifications.) ║
// ╚═══════════════════════════════════════════════════════════╝
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwdtAmqs7wGa1S-niAn5KfiDsQHR-L-OuJPrJVkbyJf1OfAB1GvXQRIm7VAjwCz4Wvi/exec';

// ═══════════════════════════════════════════
// API HELPERS (same pattern as the Faculty app)
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
  const res = await fetchWithTimeout(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" }, // avoids CORS preflight GAS rejects
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
  tableGuides: [],
  questProgress: {},   // studentId -> { "levelNo-questNo": true }
  questVideos: {},     // "levelNo-questNo" -> { title, url }  (director-assigned "watch" videos)
  videoSubmissions: {}, // "levelNo-questNo" -> url (this student's own uploaded testimony videos)
  photoSubmissions: {}, // "levelNo-questNo" -> url (this student's own uploaded quest photos)
  credits: [],          // this student's LC_CREDITS rows (their earned points)
  lessonPoints: [],     // this student's STUDENT_LESSON_POINTS rows (Attendance/
                        // Participation/Homework/Memory Verse grid — same source
                        // the Faculty app's Points leaderboard totals come from)
  redeemItems: [],      // Redeem Store catalog (REDEEM_ITEMS, Active items only)
  redemptions: [],      // this student's REDEMPTIONS rows (points already spent)
  levelQuests: {},      // Director/Consultant-customized tasks: levelNo -> [{icon,type,title}]
                        // (LEVEL_QUESTS sheet). A level with no rows falls back to QUESTS below.
  attendance: [],        // this student's own STUDENT_ATTENDANCE rows (server-side filtered)
  makeupStatus: {},      // attendanceId -> { status, notes } (this student's own MAKEUP_STATUS rows)
  makeupVideos: {},      // weekNo -> { title, url } (Director/Consultant-assigned make-up class video)
  currentStudent: null,
  currentScreen: 's-login',
  currentWeek: 1        // from SYSTEM_SETTINGS "Current Week" — Level N stays locked until this reaches N
};

let currentLevel = 1;

// ═══════════════════════════════════════════
// LEVEL CHALLENGE — WATCH-QUEST VIDEO GATING
// Director/Consultant rule: a student must actually watch the assigned
// video start-to-finish (no dragging the seek bar ahead) before the
// "Mark as Watched — Complete" button will work. Enforced only for
// YouTube-hosted quest videos, since that's the only case where the
// YouTube IFrame Player API gives us real playback control; a plain
// "open in a new tab" link (non-YouTube host) can't be policed this way.
// ═══════════════════════════════════════════
let ytApiPromise = null;
const ytPlayers = {};      // questKey -> YT.Player instance
const ytPollTimers = {};   // questKey -> setInterval id
const watchProgress = {};  // questKey -> { furthest: seconds, duration: seconds, ended: bool }
const SEEK_TOLERANCE_SEC = 1.5; // small allowance for normal playback drift, not real skipping

function ensureYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof prevReady === 'function') prevReady();
      resolve();
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/);
  return m ? m[1] : null;
}

// ═══════════════════════════════════════════
// LEVEL CHALLENGE — same 10 levels / 3 quests as the Faculty app used to have.
// Edit wording here if the quests change; keep in sync with SOL2_GAS_BACKEND.js
// notification message building (levelName/questTitle are sent along so the
// Faculty bell shows readable text).
// ═══════════════════════════════════════════
const TOTAL_LEVELS = 10;
const LEVEL_NAMES = {
  1: 'Getting Started', 2: 'Daily Growth', 3: 'Building Community', 4: 'Serving Others',
  5: 'Sharing Faith', 6: 'Growing Deeper', 7: 'Discipleship', 8: 'Leadership',
  9: 'Kingdom Impact', 10: 'Mission Complete',
};
const QUESTS = {
  1: [
    { icon:'🎥', type:'upload', title:'Create or upload a video testimony (at least 2 minutes long) sharing how God has worked in your life.' },
    { icon:'▶️', type:'watch',  title:'Watch the assigned video to prepare for the upcoming lessons in Module 1 (Lessons 1 and 2).' }
  ],
  2: [
    { icon:'▶️', type:'watch',       title:'Watch the assigned video for Level 2.' },
    { icon:'📸', type:'photoUpload', title:'Submit a photo of your LifeGroup (or a photo with your LifeGroup).' }
  ],
  // Levels 3–10: placeholder only, on purpose — the Director/Consultant
  // hasn't decided these tasks yet. Kept to exactly one lightweight task
  // per level (rather than zero) because a level with zero quests would
  // auto-count as "complete" for every student the instant they reach it
  // (see isLevelDoneFor below), silently unlocking the rest of the path.
  // Replace these anytime via Admin Home → Level Challenge Tasks — no
  // code changes needed, see LEVEL_QUESTS / questsForLevel below.
  3:  [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
  4:  [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
  5:  [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
  6:  [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
  7:  [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
  8:  [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
  9:  [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
  10: [ { icon:'📝', title:'Task coming soon — check back soon!' } ],
};
function questsForLevel(lvl) {
  const custom = APP.levelQuests[lvl];
  if (custom && custom.length) return custom;
  return QUESTS[lvl] || QUESTS[TOTAL_LEVELS];
}
function questKey(levelNo, questNo) { return levelNo + '-' + questNo; }
// Levels used to be a flat 3 quests each; now some levels (e.g. video quests,
// or a Director/Consultant-customized level) can have a different count, so
// this is computed from whatever questsForLevel() currently returns for each
// level rather than assumed from the static QUESTS default.
function totalQuestsCount() {
  let sum = 0;
  for (let lvl = 1; lvl <= TOTAL_LEVELS; lvl++) sum += questsForLevel(lvl).length;
  return sum;
}

function loadQuestProgressFromSheet(rows) {
  APP.questProgress = {};
  (rows || []).forEach(row => {
    const sid = String(row['Student ID'] || '');
    const lvl = Number(row['Level No']);
    const q   = Number(row['Quest No']);
    if (sid && lvl && q && (row['Completed'] === 'Yes' || row['Completed'] === true)) {
      if (!APP.questProgress[sid]) APP.questProgress[sid] = {};
      APP.questProgress[sid][questKey(lvl, q)] = true;
    }
  });
}

function isLevelDoneFor(studentId, levelNo) {
  const state = APP.questProgress[studentId] || {};
  const quests = questsForLevel(levelNo);
  for (let i = 0; i < quests.length; i++) {
    if (!state[questKey(levelNo, i + 1)]) return false;
  }
  return true;
}

function getHighestLevel(studentId) {
  let highest = 0;
  for (let lvl = 1; lvl <= TOTAL_LEVELS; lvl++) {
    if (isLevelDoneFor(studentId, lvl)) highest = lvl;
    else break;
  }
  return highest;
}

function totalQuestsDoneFor(studentId) {
  const state = APP.questProgress[studentId] || {};
  return Object.keys(state).filter(k => state[k]).length;
}

// ═══════════════════════════════════════════
// TABLE NAME HELPER
// ═══════════════════════════════════════════
function getTableLabel(tableNo) {
  if (!tableNo && tableNo !== 0) return '—';
  const guide = APP.tableGuides.find(g => String(g['Table No']) === String(tableNo));
  const name = guide && guide['Table Name'] && String(guide['Table Name']).trim();
  return name ? `${name} | Table ${tableNo}` : `Table ${tableNo}`;
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  APP.currentScreen = id;
  if (id === 's-home')  renderHome();
  if (id === 's-map') {
    renderMap(); // render immediately with the cached week, then refresh silently
    refreshCurrentWeek().then(renderMap).catch(() => {});
  }
  if (id === 's-redeem') {
    renderRedeemScreen(); // render immediately with cached data, then refresh silently
    const sid = APP.currentStudent && APP.currentStudent['Student ID'];
    if (sid) loadPointsData(sid).then(renderRedeemScreen).catch(() => {});
  }
  if (id === 's-makeup') {
    renderMakeupScreen(); // render immediately with cached data, then refresh silently
    const sid = APP.currentStudent && APP.currentStudent['Student ID'];
    if (sid) loadMakeupData(sid).then(renderMakeupScreen).catch(() => {});
  }
}

// ═══════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════
function showLoginError(msg) {
  const el = document.getElementById('stu-login-err');
  el.textContent = msg;
  el.style.display = '';
}
function hideLoginError() {
  document.getElementById('stu-login-err').style.display = 'none';
}

async function doStudentLogin() {
  hideLoginError();
  const id  = (document.getElementById('stu-login-id').value || '').trim();
  const pin = (document.getElementById('stu-login-pin').value || '').trim();
  if (!id || !pin) { showLoginError('Please enter your Student ID and PIN.'); return; }

  const btn = document.querySelector('#s-login .btn-primary');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    if (!APP.students.length) await loadStaticData();
    const student = APP.students.find(s =>
      String(s['Student ID']).toLowerCase() === id.toLowerCase() &&
      String(s['PIN'] || '').trim() === pin
    );
    if (!student) {
      showLoginError('Incorrect Student ID or PIN. Ask your Table Guide if you\'re not sure.');
      return;
    }
    if ((student['Status'] || 'Active').toLowerCase() === 'dropped') {
      showLoginError('This account is marked inactive. Please see your Table Guide.');
      return;
    }
    APP.currentStudent = student;
    document.getElementById('stu-login-id').value = '';
    document.getElementById('stu-login-pin').value = '';
    await loadQuestProgress();
    await loadVideoSubmissions(student['Student ID']);
    await loadPhotoSubmissions(student['Student ID']);
    await loadPointsData(student['Student ID']);
    await loadMakeupData(student['Student ID']);
    go('s-home');
  } catch (e) {
    showLoginError('Could not connect. Check your internet connection and try again.');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

function studentLogout() {
  APP.currentStudent = null;
  go('s-login');
}

// ═══════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════
async function loadStaticData() {
  const [studentsRes, guidesRes] = await Promise.all([
    apiGet('students'),
    apiGet('tableGuides')
  ]);
  APP.students    = studentsRes?.data || [];
  APP.tableGuides = guidesRes?.data || [];
  await Promise.all([refreshCurrentWeek(), loadQuestVideos(), loadRedeemItems(), loadLevelQuests()]);
}

// Pulls Director/Consultant-customized Level Challenge tasks from the
// LEVEL_QUESTS sheet. A level with no rows there is left out of the map,
// so questsForLevel() falls back to the built-in QUESTS default for it.
async function loadLevelQuests() {
  try {
    const res = await apiGet('levelQuests');
    const rows = res?.data || [];
    const byLevel = {};
    rows.forEach(r => {
      const lvl = Number(r['Level No']), qNo = Number(r['Quest No']);
      if (!lvl || !qNo) return;
      if (!byLevel[lvl]) byLevel[lvl] = [];
      byLevel[lvl][qNo - 1] = {
        icon: r['Icon'] || '⭐',
        type: String(r['Type'] || '').trim() || undefined,
        title: r['Title'] || ''
      };
    });
    // Drop any gaps left by a skipped Quest No so the array is dense.
    Object.keys(byLevel).forEach(lvl => { byLevel[lvl] = byLevel[lvl].filter(Boolean); });
    APP.levelQuests = byLevel;
  } catch (e) {
    console.warn('Failed to load custom level quests:', e);
  }
}

// Pulls the Redeem Store catalog (Director/Consultant-managed). Only items
// marked Active show up — blank/missing "Active" defaults to shown.
async function loadRedeemItems() {
  try {
    const res = await apiGet('redeemItems');
    const rows = res?.data || [];
    APP.redeemItems = rows.filter(it => String(it['Active'] ?? 'Yes').trim().toLowerCase() !== 'no');
  } catch (e) {
    console.warn('Failed to load redeem store items:', e);
  }
}

// Pulls Director/Consultant-assigned "watch this video" links from the
// QUEST_VIDEOS sheet. Safe to call anytime — leaves prior data in place on failure.
async function loadQuestVideos() {
  try {
    const res = await apiGet('questVideos');
    const rows = res?.data || [];
    const map = {};
    rows.forEach(r => {
      const lvl = Number(r['Level No']), q = Number(r['Quest No']);
      if (lvl && q) map[questKey(lvl, q)] = { title: r['Video Title'] || '', url: String(r['Video URL'] || '').trim() };
    });
    APP.questVideos = map;
  } catch (e) {
    console.warn('Failed to load quest videos:', e);
  }
}

// Pulls "Current Week" out of SYSTEM_SETTINGS. Safe to call anytime — falls
// back to whatever week was already loaded if the setting is missing/blank.
async function refreshCurrentWeek() {
  try {
    const res = await apiGet('settings');
    const rows = res?.data || [];
    const row = rows.find(r => String(r['Setting'] || '').trim().toLowerCase() === 'current week');
    const wk = row ? Number(row['Value']) : NaN;
    if (!isNaN(wk) && wk > 0) APP.currentWeek = wk;
  } catch (e) {
    console.warn('Failed to refresh current week:', e);
  }
}

async function loadQuestProgress() {
  try {
    const res = await apiGet('questProgress');
    loadQuestProgressFromSheet(res?.data || []);
  } catch (e) { console.warn('Failed to load quest progress:', e); }
}

// Fetches only THIS student's saved video-testimony links (server-side
// filtered by studentId) so other students' submissions never reach the device.
async function loadVideoSubmissions(studentId) {
  try {
    const res = await apiGet('videoSubmissions', `&studentId=${encodeURIComponent(studentId)}`);
    const rows = res?.data || [];
    const map = {};
    rows.forEach(r => {
      const lvl = Number(r['Level No']), q = Number(r['Quest No']);
      if (lvl && q && r['Video URL']) map[questKey(lvl, q)] = String(r['Video URL']);
    });
    APP.videoSubmissions = map;
  } catch (e) {
    console.warn('Failed to load video submissions:', e);
  }
}

// Fetches only THIS student's saved quest-photo links (server-side
// filtered by studentId) so other students' submissions never reach the device.
async function loadPhotoSubmissions(studentId) {
  try {
    const res = await apiGet('photoSubmissions', `&studentId=${encodeURIComponent(studentId)}`);
    const rows = res?.data || [];
    const map = {};
    rows.forEach(r => {
      const lvl = Number(r['Level No']), q = Number(r['Quest No']);
      if (lvl && q && r['Photo URL']) map[questKey(lvl, q)] = String(r['Photo URL']);
    });
    APP.photoSubmissions = map;
  } catch (e) {
    console.warn('Failed to load photo submissions:', e);
  }
}

// Fetches only THIS student's earned points (LC_CREDITS) and past
// redemptions (server-side filtered by studentId, so one student's device
// never sees another student's points or spending history).
async function loadPointsData(studentId) {
  try {
    const [creditsRes, redemptionsRes, lessonPointsRes] = await Promise.all([
      apiGet('credits', `&studentId=${encodeURIComponent(studentId)}`),
      apiGet('redemptions', `&studentId=${encodeURIComponent(studentId)}`),
      apiGet('lessonPoints', `&studentId=${encodeURIComponent(studentId)}`)
    ]);
    APP.credits = creditsRes?.data || [];
    APP.redemptions = redemptionsRes?.data || [];
    APP.lessonPoints = lessonPointsRes?.data || [];
  } catch (e) {
    console.warn('Failed to load points data:', e);
  }
}

// ═══════════════════════════════════════════
// HOME DASHBOARD
// ═══════════════════════════════════════════
function renderHome() {
  const s = APP.currentStudent;
  if (!s) return;
  document.getElementById('stu-home-name').textContent = s['Full Name'] || '—';
  document.getElementById('stu-home-table').textContent = getTableLabel(s['Table No']);

  const highest = getHighestLevel(s['Student ID']);
  const totalQuests = totalQuestsDoneFor(s['Student ID']);
  document.getElementById('stu-info-level').textContent = `${highest}/${TOTAL_LEVELS}`;
  document.getElementById('stu-info-quests').textContent = `${totalQuests}/${totalQuestsCount()}`;
  document.getElementById('stu-progress-badge').textContent =
    highest >= TOTAL_LEVELS ? 'All Done! 🏆' : `Level ${highest + 1}`;
  document.getElementById('stu-progress-fill').style.width = (totalQuests / totalQuestsCount() * 100) + '%';

  const curEl = document.getElementById('stu-home-current-pts');
  const redEl = document.getElementById('stu-home-redeem-pts');
  if (curEl) curEl.textContent = getCurrentPoints(s['Student ID']).toLocaleString();
  if (redEl) redEl.textContent = getAvailablePoints(s['Student ID']).toLocaleString();

  updateMakeupBadge();
}

// ═══════════════════════════════════════════
// MAKE-UP CLASS
// Director/Consultant rule: a student marked Absent for a week must watch
// that week's assigned YouTube video start-to-finish (no dragging the seek
// bar ahead, no completing early) before the make-up class can be marked
// done — enforced exactly the same way as a Level Challenge "watch" quest
// (see the WATCH-QUEST VIDEO GATING block above; the same ytPlayers /
// watchProgress / onWatchPlayerReady / onWatchPlayerStateChange /
// startWatchPolling / pollWatchProgress / unlockWatchCompleteButton /
// destroyWatchPlayers machinery is reused here, just keyed by
// "mk-<attendanceId>" instead of "<level>-<quest>" so both screens can
// share one player pool without colliding).
// ═══════════════════════════════════════════

// Fetches this student's own attendance history, make-up status, and the
// Director/Consultant-assigned weekly make-up videos. Attendance and
// make-up status are server-side filtered by studentId (the backend does
// this the same way it already does for credits/lessonPoints/etc.) so one
// student's device never receives another student's attendance record.
async function loadMakeupData(studentId) {
  try {
    const [attRes, mkRes, mkVidRes] = await Promise.all([
      apiGet('studentAttendance', `&studentId=${encodeURIComponent(studentId)}`),
      apiGet('makeupStatus', `&studentId=${encodeURIComponent(studentId)}`),
      apiGet('makeupVideos')
    ]);
    APP.attendance = attRes?.data || [];

    APP.makeupStatus = {};
    (mkRes?.data || []).forEach(r => {
      const attId = String(r['Attendance ID'] || '');
      if (attId) APP.makeupStatus[attId] = { status: r['Status'] || 'Pending', notes: r['Notes'] || '' };
    });

    APP.makeupVideos = {};
    (mkVidRes?.data || []).forEach(r => {
      const wk = r['Week No'];
      if (wk === '' || wk === undefined || wk === null) return;
      APP.makeupVideos[String(wk)] = { title: r['Video Title'] || '', url: String(r['Video URL'] || '').trim() };
    });
  } catch (e) {
    console.warn('Failed to load make-up class data:', e);
  }
}

// One item per week this student was marked Absent, joined with its
// make-up status (defaults to "Pending" if no MAKEUP_STATUS row exists
// yet — same default the Faculty app's Admin Makeup screen uses) and the
// week's assigned video, if any. Handles both "Attendance Status" and the
// older "Status" header name, same fallback the Faculty app already uses.
function getMakeupItems() {
  const s = APP.currentStudent;
  if (!s) return [];
  const sid = s['Student ID'];
  return (APP.attendance || [])
    .filter(a => String(a['Student ID']) === String(sid) &&
      String(a['Attendance Status'] || a['Status'] || '').toLowerCase() === 'absent')
    .map(a => {
      const attendanceId = String(a['Attendance ID'] || '');
      const weekNo = Number(a['Week No'] || 0);
      const status = (APP.makeupStatus[attendanceId] && APP.makeupStatus[attendanceId].status) || 'Pending';
      const video = APP.makeupVideos[String(weekNo)] || { title: '', url: '' };
      return { attendanceId, weekNo, status, video, tableNo: a['Table No'] || '' };
    })
    .sort((x, y) => x.weekNo - y.weekNo);
}

function pendingMakeupCount() {
  return getMakeupItems().filter(it => it.status !== 'Done').length;
}

// Keeps the Home card and the Make-up Class screen's badge in sync.
function updateMakeupBadge() {
  const count = pendingMakeupCount();
  const badge = document.getElementById('stu-makeup-badge');
  if (badge) {
    if (count > 0) { badge.textContent = String(count); badge.style.display = ''; }
    else badge.style.display = 'none';
  }
  const sub = document.getElementById('stu-makeup-sub');
  if (sub) {
    sub.textContent = count > 0
      ? `⚠️ You have ${count} make-up class${count === 1 ? '' : 'es'} to watch.`
      : (getMakeupItems().length ? "You're all caught up — nice work!" : "No make-up classes — great attendance!");
  }
}

function renderMakeupScreen() {
  const list = document.getElementById('stu-makeup-list');
  if (!list) return;

  // Tear down any live YouTube players/timers before wiping the DOM —
  // otherwise their poll intervals keep firing against detached iframes.
  destroyWatchPlayers();

  const items = getMakeupItems();
  if (!items.length) {
    list.innerHTML = '<div class="tg-note">🎉 No make-up classes — you haven\'t missed a week!</div>';
    updateMakeupBadge();
    return;
  }

  list.innerHTML = items.map(renderMakeupCard).join('');
  updateMakeupBadge();
  initMakeupPlayers(items);
}

function renderMakeupCard(item) {
  const key = 'mk-' + item.attendanceId;
  const done = item.status === 'Done';
  const noVideo = !item.video.url;
  const ytId = extractYouTubeId(item.video.url);
  const alreadyEnded = !!(watchProgress[key] && watchProgress[key].ended);
  // Gate the complete button (no fast-forward past what's actually been
  // watched, no completing before the video ends) only when we have real
  // playback control — i.e. a YouTube-hosted video that isn't already done.
  const gated = !done && !!ytId;

  let player;
  if (noVideo) {
    player = `<div class="qv-watch-link qv-disabled">📹 Your Table Guide/Director hasn't uploaded this week's make-up class video yet — check back soon</div>`;
  } else if (gated) {
    player = `
      <div class="qv-video-frame" id="qv-yt-${key}"></div>
      <div class="qv-controls-row">
        <button type="button" class="qv-playpause-btn" id="qv-playpause-${key}" onclick="toggleYtPlayback('${key}')">▶ Play</button>
        <div class="qv-progress-track"><div class="qv-progress-fill" id="qv-fill-${key}"></div></div>
        <span class="qv-time-label" id="qv-time-${key}">0:00 / 0:00</span>
      </div>
      <div class="qv-note">Watch the full video without skipping ahead — the button below unlocks once it's finished.</div>`;
  } else if (ytId) {
    // Already marked done — no need to enforce anything, just let them rewatch normally.
    player = `<div class="qv-video-frame"><iframe src="https://www.youtube.com/embed/${ytId}" allowfullscreen allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" loading="lazy"></iframe></div>`;
  } else {
    player = `<a class="qv-watch-link" href="${item.video.url}" target="_blank" rel="noopener">▶️ Watch Video${item.video.title ? ' — ' + escapeHtml(item.video.title) : ''}</a>`;
  }

  const locked = gated && !alreadyEnded;
  const btnLabel = done
    ? '✓ Make-up Class Completed'
    : (noVideo ? '🔒 Waiting for video' : (locked ? '🔒 Watch the full video to unlock' : 'Mark as Completed'));

  return `
    <div class="quest-card qc-video${done ? ' qc-done' : ''}">
      <div class="qv-header">
        <div class="quest-icon">🎬</div>
        <div class="quest-text">
          <div class="quest-title">Week ${item.weekNo} Make-up Class${item.video.title ? ' — ' + escapeHtml(item.video.title) : ''}</div>
          <div class="quest-hint">You were marked Absent for Week ${item.weekNo}</div>
        </div>
      </div>
      ${player}
      <button class="qv-complete-btn${done ? ' qv-done' : ''}${(locked || noVideo) ? ' qv-locked' : ''}" id="qv-btn-${key}"
        ${(done || locked || noVideo) ? 'disabled' : ''} onclick="toggleMakeupComplete('${item.attendanceId}')">
        ${btnLabel}
      </button>
    </div>`;
}

// Same YouTube IFrame Player lifecycle as initWatchPlayers, just iterating
// make-up items instead of Level Challenge quests. onWatchPlayerReady /
// onWatchPlayerStateChange are fully generic on "key" already, so they're
// reused as-is — no separate copies needed.
function initMakeupPlayers(items) {
  items.forEach((item) => {
    const key = 'mk-' + item.attendanceId;
    const done = item.status === 'Done';
    const ytId = extractYouTubeId(item.video.url);
    if (done || !ytId) return; // nothing to gate — either finished already, or not a policeable video

    if (!watchProgress[key]) watchProgress[key] = { furthest: 0, duration: 0, ended: false };
    ensureYouTubeApi().then(() => {
      const container = document.getElementById(`qv-yt-${key}`);
      if (!container) return; // list was re-rendered again before the API loaded
      ytPlayers[key] = new YT.Player(`qv-yt-${key}`, {
        videoId: ytId,
        playerVars: {
          controls: 0, disablekb: 1, rel: 0, modestbranding: 1,
          iv_load_policy: 3, playsinline: 1, origin: location.origin
        },
        events: {
          onReady: () => onWatchPlayerReady(key),
          onStateChange: (e) => onWatchPlayerStateChange(key, e)
        }
      });
    });
  });
}

async function toggleMakeupComplete(attendanceId) {
  const s = APP.currentStudent;
  if (!s) return;
  const item = getMakeupItems().find(it => it.attendanceId === attendanceId);
  if (!item || item.status === 'Done') return; // one-way — already done, or not found

  // optimistic local update so it feels instant
  APP.makeupStatus[attendanceId] = { status: 'Done', notes: 'Watched via Student App' };
  renderMakeupScreen();

  try {
    await apiPost({
      action: 'updateMakeupStatus',
      attendanceId,
      studentId: s['Student ID'],
      studentName: s['Full Name'] || '',
      weekNo: item.weekNo,
      tableNo: s['Table No'] || '',
      status: 'Done',
      updatedBy: s['Full Name'] || '', // self-reported
      notes: 'Watched via Student App'
    });
    showSentToast('✅ Make-up class marked complete!');
  } catch (e) {
    console.warn('toggleMakeupComplete failed:', e);
  }
}

// ═══════════════════════════════════════════
// LEVEL CHALLENGE — MAP
// ═══════════════════════════════════════════
const LC_NODE_X = [160,235,160,85,160,235,160,85,160,160];
const LC_NODE_Y = [940,845,750,655,560,465,370,275,180,85];

function renderMap() {
  const wrap = document.getElementById('stu-map-scroll');
  const s = APP.currentStudent;
  if (!wrap || !s) return;
  const highest = getHighestLevel(s['Student ID']);
  const vbH = LC_NODE_Y[0] + 60;
  let svg = `<svg class="map-svg" viewBox="0 0 320 ${vbH}" xmlns="http://www.w3.org/2000/svg">`;

  let pathD = `M ${LC_NODE_X[0]} ${LC_NODE_Y[0]}`;
  for (let i = 1; i < TOTAL_LEVELS; i++) pathD += ` L ${LC_NODE_X[i]} ${LC_NODE_Y[i]}`;
  svg += `<path d="${pathD}" class="path-line"/>`;

  for (let i = 0; i < TOTAL_LEVELS; i++) {
    const lvl = i + 1;
    const completed = lvl <= highest;
    const questsReady = lvl <= highest + 1;   // previous level's quests are done
    const weekReady = lvl <= APP.currentWeek; // program has reached this week
    const unlocked = questsReady && weekReady;
    const isFinale = lvl === TOTAL_LEVELS;
    let cls = 'lvl-node ' + (isFinale ? 'finale-node ' : '') + (completed ? 'completed' : (unlocked ? 'current' : 'locked'));
    const r = isFinale ? 34 : 30;
    svg += `<g class="${cls}" data-level="${lvl}" onclick="tapLevelNode(${lvl})">`;
    svg += `<circle class="base" cx="${LC_NODE_X[i]}" cy="${LC_NODE_Y[i]}" r="${r}"/>`;
    if (!unlocked) {
      // 🔒 = still finishing an earlier level, 📅 = ready but waiting on the week to advance
      const lockIcon = (questsReady && !weekReady) ? '📅' : '🔒';
      svg += `<text x="${LC_NODE_X[i]}" y="${LC_NODE_Y[i]+1}" font-size="20" text-anchor="middle" dominant-baseline="central">${lockIcon}</text>`;
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
    <div style="background:#fff;border-radius:14px;padding:12px 14px;box-shadow:var(--shadow);font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:8px">
      📅 We're on <b>Week ${APP.currentWeek}</b>. A level unlocks once you've finished the one before it <i>and</i> its week has arrived — even if you're done early, it opens on schedule.
    </div>
    <div style="background:#fff;border-radius:14px;padding:12px 14px;box-shadow:var(--shadow);font-size:12px;color:var(--text2);line-height:1.5">
      🏆 <b>Level 10</b> is the grand finale — there's no in-app prize, the real surprise is handed out at the SOL2 closing program once every level's quests are done.
    </div>
  </div>`;

  wrap.innerHTML = banner + svg;
}

function tapLevelNode(lvl) {
  const s = APP.currentStudent;
  if (!s) return;
  const highest = getHighestLevel(s['Student ID']);
  if (lvl > highest + 1) {
    toastLocked();
    return;
  }
  if (lvl > APP.currentWeek) {
    toastLocked(`Level ${lvl} opens on Week ${lvl}. We're on Week ${APP.currentWeek} right now.`);
    return;
  }
  openQuests(lvl);
  go('s-quests');
}

function toastLocked(message) {
  const wrap = document.getElementById('stu-map-scroll');
  if (!wrap) return;
  wrap.classList.add('lc-shake');
  setTimeout(() => wrap.classList.remove('lc-shake'), 300);
  if (message) {
    const toast = document.getElementById('stu-sent-toast');
    if (toast) {
      const prevText = toast.textContent;
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => { toast.classList.remove('show'); toast.textContent = prevText; }, 2600);
    }
  }
}

// ═══════════════════════════════════════════
// LEVEL CHALLENGE — QUESTS (self check-off)
// ═══════════════════════════════════════════
function openQuests(lvl) {
  currentLevel = lvl;
  document.getElementById('stu-game-overlay').classList.remove('show');
  document.getElementById('stu-quest-topbar-title').textContent = 'Level ' + lvl + ' — ' + LEVEL_NAMES[lvl];
  const qCount = questsForLevel(lvl).length;
  document.getElementById('stu-quest-sub-label').textContent =
    lvl === TOTAL_LEVELS
      ? `Finish all ${qCount} to complete the SOL2 Level Challenge`
      : `Finish all ${qCount} quest${qCount === 1 ? '' : 's'} to unlock Level ${lvl + 1}`;
  renderQuestList();
}

function renderQuestList() {
  const s = APP.currentStudent;
  if (!s) return;
  const sid = s['Student ID'];
  const state = APP.questProgress[sid] || {};
  const quests = questsForLevel(currentLevel);
  const list = document.getElementById('stu-quest-list');

  // Tear down any live YouTube players/timers before wiping the DOM —
  // otherwise their poll intervals keep firing against detached iframes.
  destroyWatchPlayers();

  list.innerHTML = quests.map((q, idx) => {
    const done = !!state[questKey(currentLevel, idx + 1)];
    if (q.type === 'watch')       return renderWatchQuestCard(q, idx, done, quests.length);
    if (q.type === 'upload')      return renderUploadQuestCard(q, idx, done, quests.length);
    if (q.type === 'photoUpload') return renderPhotoUploadQuestCard(q, idx, done, quests.length);
    return `
      <div class="quest-card${done ? ' qc-done' : ''}">
        <div class="quest-icon">${q.icon}</div>
        <div class="quest-text">
          <div class="quest-title">${q.title}</div>
          <div class="quest-hint">Quest ${idx + 1} of ${quests.length}</div>
        </div>
        <div class="quest-check${done ? ' checked' : ''}" onclick="toggleQuestSelf(${idx})">${done ? '✓' : ''}</div>
      </div>`;
  }).join('');
  updateQuestProgressBar();
  initWatchPlayers(quests, state);
}

// Converts a YouTube link into an embeddable URL. Returns null for anything
// else (Drive links, Facebook, etc.) so the caller falls back to a plain
// "open in new tab" button instead of a broken iframe.
function embedVideoUrl(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

function renderWatchQuestCard(q, idx, done, totalInLevel) {
  const key = questKey(currentLevel, idx + 1);
  const vid = APP.questVideos[key] || {};
  const ytId = extractYouTubeId(vid.url);
  const alreadyEnded = !!(watchProgress[key] && watchProgress[key].ended);
  // Gate the complete button (no fast-forward past what's actually been
  // watched, no completing before the video ends) only when we have real
  // playback control — i.e. a YouTube-hosted video that isn't already
  // marked complete. Anything else (no video yet, or a non-YouTube link
  // that only opens in a new tab) can't be technically policed, so it
  // falls back to the previous behavior.
  const gated = !done && !!ytId;

  let player;
  if (!vid.url) {
    player = `<div class="qv-watch-link qv-disabled">📹 Video not uploaded yet — check back soon</div>`;
  } else if (gated) {
    player = `
      <div class="qv-video-frame" id="qv-yt-${key}"></div>
      <div class="qv-controls-row">
        <button type="button" class="qv-playpause-btn" id="qv-playpause-${key}" onclick="toggleYtPlayback('${key}')">▶ Play</button>
        <div class="qv-progress-track"><div class="qv-progress-fill" id="qv-fill-${key}"></div></div>
        <span class="qv-time-label" id="qv-time-${key}">0:00 / 0:00</span>
      </div>
      <div class="qv-note">Watch the full video without skipping ahead — the button below unlocks once it's finished.</div>`;
  } else if (ytId) {
    // Already marked complete — no need to enforce anything, just let them rewatch normally.
    player = `<div class="qv-video-frame"><iframe src="https://www.youtube.com/embed/${ytId}" allowfullscreen allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" loading="lazy"></iframe></div>`;
  } else {
    player = `<a class="qv-watch-link" href="${vid.url}" target="_blank" rel="noopener">▶️ Watch Video${vid.title ? ' — ' + escapeHtml(vid.title) : ''}</a>`;
  }

  const locked = gated && !alreadyEnded;
  const btnLabel = done
    ? '✓ Marked as watched — tap to undo'
    : (locked ? '🔒 Watch the full video to unlock' : 'Mark as Watched — Complete');

  return `
    <div class="quest-card qc-video${done ? ' qc-done' : ''}">
      <div class="qv-header">
        <div class="quest-icon">${q.icon}</div>
        <div class="quest-text">
          <div class="quest-title">${q.title}</div>
          <div class="quest-hint">Quest ${idx + 1} of ${totalInLevel}</div>
        </div>
      </div>
      ${player}
      <button class="qv-complete-btn${done ? ' qv-done' : ''}${locked ? ' qv-locked' : ''}" id="qv-btn-${key}"
        ${locked ? 'disabled' : ''} onclick="toggleQuestSelf(${idx})">
        ${btnLabel}
      </button>
    </div>`;
}

/************************************************
 * WATCH-QUEST PLAYER LIFECYCLE (anti-fast-forward + completion gate)
 ************************************************/

function initWatchPlayers(quests, state) {
  quests.forEach((q, idx) => {
    if (q.type !== 'watch') return;
    const key = questKey(currentLevel, idx + 1);
    const done = !!state[key];
    const vid = APP.questVideos[key] || {};
    const ytId = extractYouTubeId(vid.url);
    if (done || !ytId) return; // nothing to gate — either finished already, or not a policeable video

    if (!watchProgress[key]) watchProgress[key] = { furthest: 0, duration: 0, ended: false };
    ensureYouTubeApi().then(() => {
      const container = document.getElementById(`qv-yt-${key}`);
      if (!container) return; // list was re-rendered again before the API loaded
      ytPlayers[key] = new YT.Player(`qv-yt-${key}`, {
        videoId: ytId,
        playerVars: {
          controls: 0, disablekb: 1, rel: 0, modestbranding: 1,
          iv_load_policy: 3, playsinline: 1, origin: location.origin
        },
        events: {
          onReady: () => onWatchPlayerReady(key),
          onStateChange: (e) => onWatchPlayerStateChange(key, e)
        }
      });
    });
  });
}

function destroyWatchPlayers() {
  Object.keys(ytPollTimers).forEach(stopWatchPolling);
  Object.keys(ytPlayers).forEach(key => {
    try { ytPlayers[key].destroy(); } catch (e) { /* iframe already gone — fine */ }
    delete ytPlayers[key];
  });
}

function onWatchPlayerReady(key) {
  const p = ytPlayers[key];
  if (!p) return;
  watchProgress[key].duration = p.getDuration() || 0;
  updateWatchProgressUI(key, watchProgress[key].furthest, watchProgress[key].duration);
}

function onWatchPlayerStateChange(key, e) {
  const p = ytPlayers[key];
  if (!p || !window.YT) return;
  const btn = document.getElementById(`qv-playpause-${key}`);
  if (e.data === YT.PlayerState.PLAYING) {
    if (btn) btn.textContent = '⏸ Pause';
    startWatchPolling(key);
  } else if (e.data === YT.PlayerState.PAUSED) {
    if (btn) btn.textContent = '▶ Play';
    stopWatchPolling(key);
  } else if (e.data === YT.PlayerState.ENDED) {
    if (btn) btn.textContent = '▶ Play';
    stopWatchPolling(key);
    const st = watchProgress[key];
    st.ended = true;
    st.furthest = st.duration || st.furthest;
    updateWatchProgressUI(key, st.furthest, st.duration);
    unlockWatchCompleteButton(key);
  }
}

function startWatchPolling(key) {
  stopWatchPolling(key);
  ytPollTimers[key] = setInterval(() => pollWatchProgress(key), 400);
}

function stopWatchPolling(key) {
  if (ytPollTimers[key]) {
    clearInterval(ytPollTimers[key]);
    delete ytPollTimers[key];
  }
}

function pollWatchProgress(key) {
  const p = ytPlayers[key];
  const st = watchProgress[key];
  if (!p || !st || typeof p.getCurrentTime !== 'function') return;
  const cur = p.getCurrentTime();
  const dur = p.getDuration() || st.duration || 0;

  if (cur > st.furthest + SEEK_TOLERANCE_SEC) {
    // Student dragged/skipped ahead of what they've actually watched —
    // snap the playhead back so they can't fast-forward through it.
    p.seekTo(st.furthest, true);
  } else {
    st.furthest = Math.max(st.furthest, cur);
  }

  updateWatchProgressUI(key, st.furthest, dur);

  if (dur && st.furthest >= dur - 0.75 && !st.ended) {
    st.ended = true;
    unlockWatchCompleteButton(key);
  }
}

function updateWatchProgressUI(key, cur, dur) {
  const fill = document.getElementById(`qv-fill-${key}`);
  const time = document.getElementById(`qv-time-${key}`);
  if (fill) fill.style.width = dur ? Math.min(100, (cur / dur) * 100) + '%' : '0%';
  if (time) time.textContent = `${formatSeconds(cur)} / ${formatSeconds(dur)}`;
}

function formatSeconds(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function unlockWatchCompleteButton(key) {
  const btn = document.getElementById(`qv-btn-${key}`);
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('qv-locked');
  btn.textContent = 'Mark as Watched — Complete';
}

function toggleYtPlayback(key) {
  const p = ytPlayers[key];
  if (!p || typeof p.getPlayerState !== 'function') return;
  const state = p.getPlayerState();
  if (state === 1 /* YT.PlayerState.PLAYING */) p.pauseVideo();
  else p.playVideo();
}

function renderUploadQuestCard(q, idx, done, totalInLevel) {
  const sid = APP.currentStudent['Student ID'];
  const inputId = `qv-file-${idx}`;
  const submittedUrl = (APP.videoSubmissions && APP.videoSubmissions[questKey(currentLevel, idx + 1)]) || '';
  const bodyContent = (done && submittedUrl)
    ? `<a class="qv-watch-link" href="${submittedUrl}" target="_blank" rel="noopener">🎬 View your submitted video</a>
       <label class="qv-replace-link" for="${inputId}">Replace video</label>`
    : `<label class="qv-upload-zone" for="${inputId}">📤 Tap to choose your testimony video<br><span>MP4/MOV, up to ${Math.round(MAX_UPLOAD_BYTES/1024/1024)}MB, at least 2 minutes</span></label>`;
  return `
    <div class="quest-card qc-video${done ? ' qc-done' : ''}">
      <div class="qv-header">
        <div class="quest-icon">${q.icon}</div>
        <div class="quest-text">
          <div class="quest-title">${q.title}</div>
          <div class="quest-hint">Quest ${idx + 1} of ${totalInLevel}</div>
        </div>
      </div>
      <div id="qv-body-${idx}">${bodyContent}</div>
      <input type="file" accept="video/*" id="${inputId}" style="display:none" onchange="handleVideoChosen(${idx}, this.files[0])">
      <div id="qv-status-${idx}"></div>
    </div>`;
}

function renderPhotoUploadQuestCard(q, idx, done, totalInLevel) {
  const inputId = `qp-file-${idx}`;
  const submittedUrl = (APP.photoSubmissions && APP.photoSubmissions[questKey(currentLevel, idx + 1)]) || '';
  const bodyContent = (done && submittedUrl)
    ? `<a class="qv-watch-link" href="${submittedUrl}" target="_blank" rel="noopener">📸 View your submitted photo</a>
       <label class="qv-replace-link" for="${inputId}">Replace photo</label>`
    : `<label class="qv-upload-zone" for="${inputId}">📤 Tap to choose a photo<br><span>JPG/PNG, up to ${Math.round(MAX_PHOTO_BYTES/1024/1024)}MB</span></label>`;
  return `
    <div class="quest-card qc-video${done ? ' qc-done' : ''}">
      <div class="qv-header">
        <div class="quest-icon">${q.icon}</div>
        <div class="quest-text">
          <div class="quest-title">${q.title}</div>
          <div class="quest-hint">Quest ${idx + 1} of ${totalInLevel}</div>
        </div>
      </div>
      <div id="qp-body-${idx}">${bodyContent}</div>
      <input type="file" accept="image/*" id="${inputId}" style="display:none" onchange="handlePhotoChosen(${idx}, this.files[0])">
      <div id="qp-status-${idx}"></div>
    </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function updateQuestProgressBar() {
  const s = APP.currentStudent;
  if (!s) return;
  const state = APP.questProgress[s['Student ID']] || {};
  const quests = questsForLevel(currentLevel);
  const doneCount = quests.filter((q, idx) => state[questKey(currentLevel, idx + 1)]).length;
  document.getElementById('stu-quest-progress-fill').style.width = (doneCount / quests.length * 100) + '%';
}

async function toggleQuestSelf(idx) {
  const s = APP.currentStudent;
  if (!s) return;
  const sid = s['Student ID'];
  const questNo = idx + 1;
  const wasDone = !!(APP.questProgress[sid] || {})[questKey(currentLevel, questNo)];
  const nowDone = !wasDone;

  // optimistic local update so it feels instant
  if (!APP.questProgress[sid]) APP.questProgress[sid] = {};
  if (nowDone) APP.questProgress[sid][questKey(currentLevel, questNo)] = true;
  else delete APP.questProgress[sid][questKey(currentLevel, questNo)];
  renderQuestList();

  const quest = questsForLevel(currentLevel)[idx];
  try {
    await apiPost({
      action: 'toggleQuest',
      studentId: sid,
      studentName: s['Full Name'] || '',
      tableNo: s['Table No'] || '',
      levelNo: currentLevel,
      questNo: questNo,
      questTitle: quest ? quest.title : '',
      levelName: LEVEL_NAMES[currentLevel] || '',
      completed: nowDone,
      markedBy: s['Full Name'] || '' // self-reported
    });
    if (nowDone) showSentToast();
  } catch (e) {
    console.warn('toggleQuest failed:', e);
  }

  if (nowDone && isLevelDoneFor(sid, currentLevel)) {
    setTimeout(finishLevel, 350);
  }
}

function showSentToast(message) {
  const toast = document.getElementById('stu-sent-toast');
  const prevText = toast.textContent;
  if (message) toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    if (message) toast.textContent = prevText;
  }, 2200);
}

// ═══════════════════════════════════════════
// LEVEL CHALLENGE — VIDEO TESTIMONY UPLOAD
// ═══════════════════════════════════════════
// Raw file cap. This used to be capped near Apps Script's ~50MB per-request
// ceiling (minus base64 overhead), because the whole video was sent as one
// POST. Uploads now go out in small chunks (see VIDEO_CHUNK_BYTES and
// uploadTestimonyChunked below) that get relayed into a Google Drive
// resumable-upload session, so this limit is no longer about what one
// request can carry — it's just a sane cap on how big a testimony video is
// allowed to be.
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MIN_TESTIMONY_SECONDS = 120;

// Size of each piece sent to the server. Kept well under Apps Script's
// ~50MB per-request ceiling (with room to spare even after base64's ~33%
// inflation) so each chunk request is small, fast, and easy to retry on a
// flaky mobile connection.
const VIDEO_CHUNK_BYTES = 6 * 1024 * 1024;

let pendingVideoFiles = {}; // idx -> File, chosen but not yet submitted

function handleVideoChosen(idx, file) {
  if (!file) return;
  const statusEl = document.getElementById(`qv-status-${idx}`);
  if (!statusEl) return;

  if (!file.type.startsWith('video/')) {
    statusEl.innerHTML = `<div class="qv-error">Please choose a video file.</div>`;
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    statusEl.innerHTML = `<div class="qv-error">That file is ${(file.size/1024/1024).toFixed(1)}MB — please keep it under ${Math.round(MAX_UPLOAD_BYTES/1024/1024)}MB. Try trimming it or recording at a lower quality.</div>`;
    return;
  }

  pendingVideoFiles[idx] = file;
  const objUrl = URL.createObjectURL(file);
  statusEl.innerHTML = `
    <video class="qv-preview" src="${objUrl}" controls playsinline></video>
    <div class="qv-file-name">${escapeHtml(file.name)} · ${(file.size/1024/1024).toFixed(1)}MB</div>
    <div id="qv-dur-${idx}"></div>
    <button class="qv-complete-btn" onclick="submitTestimony(${idx})">Submit Testimony</button>`;

  // Best-effort duration check — some mobile browsers/formats won't report
  // this reliably, so it's a heads-up, not a hard block.
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.onloadedmetadata = () => {
    const durEl = document.getElementById(`qv-dur-${idx}`);
    if (durEl && isFinite(probe.duration) && probe.duration > 0 && probe.duration < MIN_TESTIMONY_SECONDS) {
      durEl.className = 'qv-error';
      durEl.textContent = `Heads up — this clip is about ${Math.round(probe.duration)}s, and the task asks for at least 2 minutes. You can still submit, but consider re-recording a longer one.`;
    }
    URL.revokeObjectURL(probe.src);
  };
  probe.src = objUrl;
}

async function submitTestimony(idx) {
  const file = pendingVideoFiles[idx];
  const s = APP.currentStudent;
  if (!file || !s) return;
  const sid = s['Student ID'];
  const questNo = idx + 1;
  const statusEl = document.getElementById(`qv-status-${idx}`);
  if (statusEl) {
    statusEl.innerHTML = `
      <div class="qv-progress-track"><div class="qv-progress-fill" id="qv-prog-${idx}"></div></div>
      <div class="qv-note" id="qv-prog-label-${idx}">Uploading… 0%</div>`;
  }

  try {
    const quest = questsForLevel(currentLevel)[idx];
    const result = await uploadTestimonyChunked(file, {
      studentId: sid,
      studentName: s['Full Name'] || '',
      tableNo: s['Table No'] || '',
      levelNo: currentLevel,
      questNo: questNo,
      questTitle: quest ? quest.title : 'Video Testimony',
      levelName: LEVEL_NAMES[currentLevel] || '',
      fileName: file.name,
      mimeType: file.type || 'video/mp4',
      markedBy: s['Full Name'] || ''
    }, pct => {
      const fill = document.getElementById(`qv-prog-${idx}`);
      const label = document.getElementById(`qv-prog-label-${idx}`);
      if (fill) fill.style.width = pct + '%';
      if (label) label.textContent = `Uploading… ${pct}%`;
    });

    if (!APP.questProgress[sid]) APP.questProgress[sid] = {};
    APP.questProgress[sid][questKey(currentLevel, questNo)] = true;
    if (!APP.videoSubmissions) APP.videoSubmissions = {};
    if (result && result.videoUrl) APP.videoSubmissions[questKey(currentLevel, questNo)] = result.videoUrl;
    delete pendingVideoFiles[idx];

    renderQuestList();
    showSentToast();
    if (isLevelDoneFor(sid, currentLevel)) setTimeout(finishLevel, 350);
  } catch (e) {
    console.warn('Testimony upload failed:', e);
    if (statusEl) statusEl.innerHTML = `<div class="qv-error">Upload failed — check your connection and try again. If your video is large, try trimming it shorter first.</div>
      <button class="qv-complete-btn" onclick="submitTestimony(${idx})">Try Again</button>`;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

// ── CHUNKED VIDEO UPLOAD ──
// Splits the video into VIDEO_CHUNK_BYTES pieces and POSTs each one to the
// backend's "uploadVideoChunk" action, which relays it into a Google Drive
// resumable-upload session server-side. This is what lets testimony videos
// go well past what a single Apps Script request could ever carry — see
// the comment above uploadVideoChunk in the backend script for the why.
function makeUploadId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function uploadTestimonyChunked(file, meta, onProgress) {
  const uploadId = makeUploadId();
  const total = file.size;
  let start = 0;
  let chunkIndex = 0;
  let lastResult = null;

  if (onProgress) onProgress(0);

  while (start < total) {
    const end = Math.min(start + VIDEO_CHUNK_BYTES, total);
    const chunkBlob = file.slice(start, end);
    const base64Chunk = await fileToBase64(chunkBlob);

    const payload = Object.assign({
      action: 'uploadVideoChunk',
      uploadId: uploadId,
      chunkIndex: chunkIndex,
      rangeStart: start,
      totalBytes: total,
      base64Chunk: base64Chunk
    }, meta);

    lastResult = await postJSONWithRetry(payload, 3);
    if (!lastResult || !lastResult.success) {
      throw new Error((lastResult && lastResult.message) || 'Upload failed');
    }

    start = end;
    chunkIndex++;
    if (onProgress) onProgress(Math.round((start / total) * 100));
  }

  return lastResult;
}

// Posts one chunk, retrying on network hiccups (not on a real server-side
// rejection, which won't fix itself by retrying).
function postJSONWithRetry(payload, retriesLeft) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', GAS_URL, true);
    xhr.setRequestHeader('Content-Type', 'text/plain'); // avoids CORS preflight GAS rejects
    xhr.timeout = 3 * 60 * 1000;
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch (e) {
        reject(new Error('Unexpected response from server'));
      }
    };
    const retryOrFail = (err) => {
      if (retriesLeft > 0) {
        postJSONWithRetry(payload, retriesLeft - 1).then(resolve, reject);
      } else {
        reject(err);
      }
    };
    xhr.onerror = () => retryOrFail(new Error('Network error while uploading'));
    xhr.ontimeout = () => retryOrFail(new Error('Upload timed out'));
    xhr.send(JSON.stringify(payload));
  });
}

// ═══════════════════════════════════════════
// LEVEL CHALLENGE — QUEST PHOTO UPLOAD (e.g. Level 2 LifeGroup photo)
// ═══════════════════════════════════════════
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // raw file cap; base64 adds ~33% on top when sent to Apps Script

let pendingPhotoFiles = {}; // idx -> File, chosen but not yet submitted

function handlePhotoChosen(idx, file) {
  if (!file) return;
  const statusEl = document.getElementById(`qp-status-${idx}`);
  if (!statusEl) return;

  if (!file.type.startsWith('image/')) {
    statusEl.innerHTML = `<div class="qv-error">Please choose an image file.</div>`;
    return;
  }
  if (file.size > MAX_PHOTO_BYTES) {
    statusEl.innerHTML = `<div class="qv-error">That photo is ${(file.size/1024/1024).toFixed(1)}MB — please keep it under ${Math.round(MAX_PHOTO_BYTES/1024/1024)}MB.</div>`;
    return;
  }

  pendingPhotoFiles[idx] = file;
  const objUrl = URL.createObjectURL(file);
  statusEl.innerHTML = `
    <img class="qv-preview" src="${objUrl}" alt="Selected photo">
    <div class="qv-file-name">${escapeHtml(file.name)} · ${(file.size/1024/1024).toFixed(1)}MB</div>
    <button class="qv-complete-btn" onclick="submitPhoto(${idx})">Submit Photo</button>`;
}

async function submitPhoto(idx) {
  const file = pendingPhotoFiles[idx];
  const s = APP.currentStudent;
  if (!file || !s) return;
  const sid = s['Student ID'];
  const questNo = idx + 1;
  const statusEl = document.getElementById(`qp-status-${idx}`);
  if (statusEl) {
    statusEl.innerHTML = `
      <div class="qv-progress-track"><div class="qv-progress-fill" id="qp-prog-${idx}"></div></div>
      <div class="qv-note" id="qp-prog-label-${idx}">Uploading… 0%</div>`;
  }

  try {
    const base64 = await fileToBase64(file);
    const quest = questsForLevel(currentLevel)[idx];
    const result = await uploadPhotoXHR({
      studentId: sid,
      studentName: s['Full Name'] || '',
      tableNo: s['Table No'] || '',
      levelNo: currentLevel,
      questNo: questNo,
      questTitle: quest ? quest.title : 'Photo Submission',
      levelName: LEVEL_NAMES[currentLevel] || '',
      fileName: file.name,
      mimeType: file.type || 'image/jpeg',
      base64Data: base64,
      markedBy: s['Full Name'] || ''
    }, pct => {
      const fill = document.getElementById(`qp-prog-${idx}`);
      const label = document.getElementById(`qp-prog-label-${idx}`);
      if (pct === null) {
        if (fill) { fill.style.width = '100%'; fill.classList.add('qv-progress-indeterminate'); }
        if (label) label.textContent = 'Uploading… this may take a minute';
      } else {
        if (fill) fill.style.width = pct + '%';
        if (label) label.textContent = `Uploading… ${pct}%`;
      }
    });

    if (!APP.questProgress[sid]) APP.questProgress[sid] = {};
    APP.questProgress[sid][questKey(currentLevel, questNo)] = true;
    if (!APP.photoSubmissions) APP.photoSubmissions = {};
    if (result && result.photoUrl) APP.photoSubmissions[questKey(currentLevel, questNo)] = result.photoUrl;
    delete pendingPhotoFiles[idx];

    renderQuestList();
    showSentToast();
    if (isLevelDoneFor(sid, currentLevel)) setTimeout(finishLevel, 350);
  } catch (e) {
    console.warn('Photo upload failed:', e);
    if (statusEl) statusEl.innerHTML = `<div class="qv-error">Upload failed — check your connection and try again.</div>
      <button class="qv-complete-btn" onclick="submitPhoto(${idx})">Try Again</button>`;
  }
}

function uploadPhotoXHR(payload, onProgress) {
  return new Promise((resolve, reject) => {
    // See the note in uploadTestimonyXHR above — no upload.onprogress
    // listener, on purpose, to avoid a CORS preflight Apps Script can't answer.
    if (onProgress) onProgress(null);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', GAS_URL, true);
    xhr.setRequestHeader('Content-Type', 'text/plain');
    xhr.timeout = 5 * 60 * 1000;
    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText);
        if (res && res.success) resolve(res);
        else reject(new Error((res && res.message) || 'Upload failed'));
      } catch (e) {
        reject(new Error('Unexpected response from server'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.send(JSON.stringify(Object.assign({ action: 'uploadPhotoSubmission' }, payload)));
  });
}

// NOTE: no longer used for testimony videos (see uploadTestimonyChunked
// above) — kept only in case you want a simple single-shot path for some
// other small file type later. The CORS-preflight note below still applies
// to any single-request upload you build off of this.
function uploadTestimonyXHR(payload, onProgress) {
  return new Promise((resolve, reject) => {
    // NOTE: We intentionally do NOT attach an xhr.upload.onprogress listener.
    // Doing so — even just registering the listener — forces the browser to
    // treat this as a non-"simple" cross-origin request, which triggers a
    // CORS preflight (OPTIONS). Apps Script web apps don't implement
    // doOptions(), so any preflight gets a 405 and the whole upload fails
    // with a generic "Network error", even though the Content-Type below
    // is already safe. See: developer.mozilla.org/docs/Web/API/XMLHttpRequest/upload
    // Losing the live % bar is the trade-off for uploads actually working.
    if (onProgress) onProgress(null); // signal "indeterminate" to the caller
    const xhr = new XMLHttpRequest();
    xhr.open('POST', GAS_URL, true);
    xhr.setRequestHeader('Content-Type', 'text/plain'); // avoids CORS preflight GAS rejects (same fix as apiPost)
    xhr.timeout = 5 * 60 * 1000; // large uploads on slow connections need room
    xhr.onload = () => {
      try {
        const res = JSON.parse(xhr.responseText);
        if (res && res.success) resolve(res);
        else reject(new Error((res && res.message) || 'Upload failed'));
      } catch (e) {
        reject(new Error('Unexpected response from server'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.send(JSON.stringify(Object.assign({ action: 'uploadTestimonyVideo' }, payload)));
  });
}

function finishLevel() {
  const s = APP.currentStudent;
  const isFinale = currentLevel === TOTAL_LEVELS;
  const nextLevel = currentLevel + 1;
  const nextLevelWeekLocked = !isFinale && nextLevel > APP.currentWeek;
  const overlay = document.getElementById('stu-game-overlay');
  const nextBtn = document.getElementById('stu-overlay-next-btn');
  if (isFinale) {
    document.getElementById('stu-overlay-emoji').textContent = '🏆';
    document.getElementById('stu-overlay-title').textContent = 'All 10 Levels Complete!';
    document.getElementById('stu-overlay-sub').textContent =
      'You finished every quest in the SOL2 Level Challenge! Tell your Table Guide — the real surprise is waiting at the closing program!';
    nextBtn.style.display = 'none';
  } else if (nextLevelWeekLocked) {
    document.getElementById('stu-overlay-emoji').textContent = '⭐';
    document.getElementById('stu-overlay-title').textContent = 'Level ' + currentLevel + ' Complete!';
    document.getElementById('stu-overlay-sub').textContent =
      `All quests done! Level ${nextLevel} opens on Week ${nextLevel} — we're on Week ${APP.currentWeek} right now. Check back once your Table Guide moves the week forward.`;
    nextBtn.style.display = 'none';
  } else {
    document.getElementById('stu-overlay-emoji').textContent = '⭐';
    document.getElementById('stu-overlay-title').textContent = 'Level ' + currentLevel + ' Complete!';
    document.getElementById('stu-overlay-sub').textContent = 'All quests done. Level ' + nextLevel + ' is now unlocked.';
    nextBtn.style.display = 'block';
    nextBtn.textContent = 'Next Level →';
  }
  overlay.classList.add('show');
  launchConfetti(overlay);
  if (s) renderHome(); // keep dashboard numbers in sync for when they go back
}

function closeOverlayToMap() {
  renderMap();
  go('s-map');
}

function goToNextLevelFromOverlay() {
  const next = Math.min(currentLevel + 1, TOTAL_LEVELS);
  if (next > APP.currentWeek) { toastLocked(`Level ${next} opens on Week ${next}.`); closeOverlayToMap(); return; }
  document.getElementById('stu-game-overlay').classList.remove('show');
  openQuests(next);
  go('s-quests');
}

function launchConfetti(container) {
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

// ═══════════════════════════════════════════
// REDEEM POINTS
// ═══════════════════════════════════════════
let currentStoreItems = [];   // items currently shown in the store grid (indexed for onclick)
let pendingRedeemItem = null; // item awaiting Yes/No confirmation

// A student's total earned points = manual "Add Points" credits (LC_CREDITS)
// PLUS the Attendance/Participation/Homework/Memory Verse lesson-points grid.
// This must match getStudentCredits() in the Faculty/Admin app exactly, or
// the two apps show different totals for the same student.
function getCurrentPoints(studentId) {
  const manualCredits = (APP.credits || [])
    .filter(c => String(c['Student ID']) === String(studentId))
    .reduce((sum, c) => sum + Number(c['Credits Added'] || 0), 0);

  const lessonGridPoints = (APP.lessonPoints || [])
    .filter(r => String(r['Student ID']) === String(studentId))
    .reduce((sum, r) =>
      sum + Number(r['Attendance Points'] || 0)
          + Number(r['Participation Points'] || 0)
          + Number(r['Homework Points'] || 0)
          + Number(r['Memory Verse Points'] || 0), 0);

  return manualCredits + lessonGridPoints;
}

// Sum of everything this student has already redeemed.
function getRedeemedTotal(studentId) {
  return (APP.redemptions || [])
    .filter(r => String(r['Student ID']) === String(studentId))
    .reduce((sum, r) => sum + Number(r['Points Cost'] || 0), 0);
}

// What's left to spend = earned minus already redeemed.
function getAvailablePoints(studentId) {
  return getCurrentPoints(studentId) - getRedeemedTotal(studentId);
}

function renderRedeemScreen() {
  const s = APP.currentStudent;
  if (!s) return;
  const sid = s['Student ID'];
  const current = getCurrentPoints(sid);
  const available = getAvailablePoints(sid);

  document.getElementById('rd-student-name').textContent = s['Full Name'] || '—';
  document.getElementById('rd-current-pts').textContent = current.toLocaleString();
  document.getElementById('rd-redeem-pts').textContent = available.toLocaleString();

  currentStoreItems = (APP.redeemItems || [])
    .slice()
    .sort((a, b) => Number(a['Points Cost'] || 0) - Number(b['Points Cost'] || 0));

  const grid = document.getElementById('rd-store-grid');
  if (!currentStoreItems.length) {
    grid.innerHTML = `<div class="rd-empty">No redeemable items have been set up yet — check back soon!</div>`;
  } else {
    grid.innerHTML = currentStoreItems.map((it, idx) => {
      const cost = Number(it['Points Cost'] || 0);
      const canAfford = available >= cost;
      return `
        <div class="rd-item-card${canAfford ? '' : ' rd-item-disabled'}">
          <div class="rd-item-icon">🎁</div>
          <div class="rd-item-name">${escapeHtml(it['Item Name'] || '')}</div>
          <div class="rd-item-cost">${cost.toLocaleString()} pts</div>
          <button class="rd-item-btn" ${canAfford ? '' : 'disabled'} onclick="openRedeemConfirm(${idx})">
            ${canAfford ? 'Redeem' : 'Not enough pts'}
          </button>
        </div>`;
    }).join('');
  }

  const hist = document.getElementById('rd-history-list');
  const myRedemptions = (APP.redemptions || [])
    .slice()
    .sort((a, b) => new Date(b['Redeemed At']) - new Date(a['Redeemed At']));
  if (!myRedemptions.length) {
    hist.innerHTML = `<div class="rd-empty">No redemptions yet.</div>`;
  } else {
    hist.innerHTML = myRedemptions.map(r => {
      const dt = r['Redeemed At'] ? new Date(r['Redeemed At']) : null;
      const dateLabel = dt && !isNaN(dt) ? dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      return `
        <div class="rd-hist-row">
          <div>
            <div class="rd-hist-name">${escapeHtml(r['Item Name'] || '')}</div>
            <div class="rd-hist-date">${dateLabel}</div>
          </div>
          <div class="rd-hist-cost">-${Number(r['Points Cost'] || 0).toLocaleString()} pts</div>
        </div>`;
    }).join('');
  }
}

function openRedeemConfirm(idx) {
  const s = APP.currentStudent;
  if (!s) return;
  const it = currentStoreItems[idx];
  if (!it) return;

  const cost = Number(it['Points Cost'] || 0);
  const available = getAvailablePoints(s['Student ID']);
  if (available < cost) { renderRedeemScreen(); return; } // stale tap guard

  pendingRedeemItem = it;
  document.getElementById('rd-confirm-title').textContent = `Redeem ${it['Item Name']}?`;
  document.getElementById('rd-confirm-sub').textContent =
    `This will use ${cost.toLocaleString()} of your ${available.toLocaleString()} available points. ` +
    `Click Yes if you want to redeem this, or No if you change your mind.`;
  document.getElementById('rd-confirm-overlay').classList.add('show');
}

function closeRedeemConfirm() {
  pendingRedeemItem = null;
  document.getElementById('rd-confirm-overlay').classList.remove('show');
}

async function confirmRedeem() {
  const s = APP.currentStudent;
  const it = pendingRedeemItem;
  if (!s || !it) return;

  const btn = document.getElementById('rd-confirm-yes-btn');
  btn.disabled = true; btn.textContent = 'Redeeming…';

  try {
    const cost = Number(it['Points Cost'] || 0);
    const res = await apiPost({
      action: 'redeemReward',
      studentId: s['Student ID'],
      studentName: s['Full Name'] || '',
      tableNo: s['Table No'] || '',
      itemName: it['Item Name'] || '',
      pointsCost: cost,
      redeemedBy: s['Full Name'] || ''
    });

    if (res && res.success) {
      // Reflect it locally right away so the balance updates instantly.
      APP.redemptions.push({
        'Student ID': s['Student ID'],
        'Student Name': s['Full Name'] || '',
        'Table No': s['Table No'] || '',
        'Item Name': it['Item Name'] || '',
        'Points Cost': cost,
        'Redeemed At': new Date().toISOString()
      });
      closeRedeemConfirm();
      renderRedeemScreen();
      renderHome();
      showSentToast(`🎉 Redeemed: ${it['Item Name']}!`);
    } else {
      closeRedeemConfirm();
      showSentToast((res && res.message) || 'Could not redeem — please try again.');
      loadPointsData(s['Student ID']).then(renderRedeemScreen).catch(() => {}); // resync if balance was stale
    }
  } catch (e) {
    closeRedeemConfirm();
    showSentToast('Network error — please try again.');
  } finally {
    btn.disabled = false; btn.textContent = 'Yes, Redeem';
  }
}

// ═══════════════════════════════════════════
// INIT — pre-load students/table guides in the background so login is fast
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadStaticData().catch(e => console.warn('Initial data load failed (will retry on login):', e));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

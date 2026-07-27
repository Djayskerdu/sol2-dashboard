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
  currentStudent: null,
  currentScreen: 's-login',
  currentWeek: 1        // from SYSTEM_SETTINGS "Current Week" — Level N stays locked until this reaches N
};

let currentLevel = 1;

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
    { icon:'🎥', type:'upload', title:'Create or upload a video testimony (up to 2 minutes long) sharing how God has worked in your life.' },
    { icon:'▶️', type:'watch',  title:'Watch the assigned video to prepare for the upcoming lessons in Module 1 (Lessons 1 and 2).' }
  ],
  2: [ { icon:'📖', title:'Read the Bible for 5 consecutive days' }, { icon:'🙏', title:'Pray for 10 minutes each day for 3 days' }, { icon:'💬', title:'Share one takeaway from your Bible reading' } ],
  3: [ { icon:'🎯', title:'Attend another LifeGroup' }, { icon:'📖', title:'Encourage someone with a Bible verse' }, { icon:'🤝', title:'Invite one friend to a LifeGroup' } ],
  4: [ { icon:'🙌', title:'Volunteer during a church activity' }, { icon:'🙏', title:'Pray with someone' }, { icon:'❤️', title:'Perform one act of kindness without expecting anything in return' } ],
  5: [ { icon:'💬', title:'Share your personal testimony' }, { icon:'✝️', title:'Share the Gospel with one person' }, { icon:'🎉', title:'Invite someone to church or a church event' } ],
  6: [ { icon:'📖', title:'Complete a Bible study lesson' }, { icon:'🙏', title:'Fast for one meal while praying' }, { icon:'📖', title:'Memorize three Bible verses' } ],
  7: [ { icon:'🤝', title:'Follow up with a first-time guest' }, { icon:'🙏', title:'Pray for three friends by name' }, { icon:'🎯', title:'Encourage someone to join a LifeGroup' } ],
  8: [ { icon:'🗣️', title:'Help facilitate a LifeGroup activity' }, { icon:'🌱', title:'Mentor or encourage a newer believer' }, { icon:'🙏', title:'Lead the opening prayer in a gathering' } ],
  9: [ { icon:'✝️', title:"Share God's Word with two people" }, { icon:'🎉', title:'Bring one new guest to church' }, { icon:'🌍', title:'Participate in an outreach or mission activity' } ],
  10:[ { icon:'🎯', title:'Attend a LifeGroup' }, { icon:'✝️', title:'Share the Gospel with three people' }, { icon:'❤️', title:'Lead one person to Christ (or begin a discipleship journey with them)' } ],
};
function questsForLevel(lvl) { return QUESTS[lvl] || QUESTS[TOTAL_LEVELS]; }
function questKey(levelNo, questNo) { return levelNo + '-' + questNo; }
// Levels used to be a flat 3 quests each; now some levels (e.g. video quests)
// can have a different count, so total is computed instead of assumed.
const TOTAL_QUESTS = Object.keys(QUESTS).reduce((sum, lvl) => sum + QUESTS[lvl].length, 0);

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
  await Promise.all([refreshCurrentWeek(), loadQuestVideos()]);
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
  document.getElementById('stu-info-quests').textContent = `${totalQuests}/${TOTAL_QUESTS}`;
  document.getElementById('stu-progress-badge').textContent =
    highest >= TOTAL_LEVELS ? 'All Done! 🏆' : `Level ${highest + 1}`;
  document.getElementById('stu-progress-fill').style.width = (totalQuests / TOTAL_QUESTS * 100) + '%';
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

// ── WATCH-QUEST ANTI-SKIP GUARD ──
// Loads the real YouTube IFrame Player API (instead of a plain <iframe>) so
// we can track playback, snap back any attempt to scrub ahead of what's
// actually been watched, and keep the "Mark as Watched" button locked until
// the video has actually played through to the end.
let _ytApiPromise = null;
let ytPlayers = {};         // idx -> YT.Player instance
let watchGuardState = {};   // idx -> { maxWatched, unlocked, interval }

function loadYouTubeIframeAPI() {
  if (_ytApiPromise) return _ytApiPromise;
  _ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(window.YT); return; }
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') prevReady();
      resolve(window.YT);
    };
    if (!document.getElementById('yt-iframe-api-script')) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-api-script';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  });
  return _ytApiPromise;
}

function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/);
  return m ? m[1] : null;
}

function isWatchUnlocked(idx) {
  return !!(watchGuardState[idx] && watchGuardState[idx].unlocked);
}

function initWatchGuards() {
  const guards = document.querySelectorAll('.qv-video-frame[data-yt-id]');
  if (!guards.length) return;
  loadYouTubeIframeAPI().then((YT) => {
    guards.forEach((div) => {
      const idx = Number(div.dataset.idx);
      const videoId = div.dataset.ytId;
      if (!watchGuardState[idx]) watchGuardState[idx] = { maxWatched: 0, unlocked: false, interval: null };
      ytPlayers[idx] = new YT.Player(div, {
        videoId: videoId,
        playerVars: { rel: 0, modestbranding: 1, disablekb: 1, playsinline: 1 },
        events: {
          onStateChange: (e) => onWatchGuardStateChange(idx, e, YT)
        }
      });
    });
  });
}

function onWatchGuardStateChange(idx, e, YT) {
  const state = watchGuardState[idx];
  if (!state) return;
  if (e.data === YT.PlayerState.PLAYING) {
    if (state.interval) clearInterval(state.interval);
    state.interval = setInterval(() => pollWatchGuard(idx), 500);
  } else if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
}

function pollWatchGuard(idx) {
  const player = ytPlayers[idx];
  const state = watchGuardState[idx];
  if (!player || !state || typeof player.getCurrentTime !== 'function') return;

  let current, duration;
  try {
    current = player.getCurrentTime();
    duration = player.getDuration();
  } catch (e) { return; }
  if (!isFinite(current) || !isFinite(duration) || duration <= 0) return;

  const tolerance = 2; // small leeway for normal playback drift
  if (current > state.maxWatched + tolerance) {
    player.seekTo(state.maxWatched, true); // snap back — no skipping ahead
  } else {
    state.maxWatched = Math.max(state.maxWatched, current);
  }

  if (!state.unlocked && state.maxWatched >= duration - 2) {
    state.unlocked = true;
    const btn = document.getElementById(`qv-complete-btn-${idx}`);
    const note = document.getElementById(`qv-watch-note-${idx}`);
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('qv-btn-disabled');
      btn.textContent = 'Mark as Watched — Complete';
    }
    if (note) note.textContent = '✅ Video watched — you can mark this complete now.';
  }
}

function renderQuestList() {
  const s = APP.currentStudent;
  if (!s) return;
  const sid = s['Student ID'];
  const state = APP.questProgress[sid] || {};
  const quests = questsForLevel(currentLevel);
  const list = document.getElementById('stu-quest-list');
  list.innerHTML = quests.map((q, idx) => {
    const done = !!state[questKey(currentLevel, idx + 1)];
    if (q.type === 'watch')  return renderWatchQuestCard(q, idx, done, quests.length);
    if (q.type === 'upload') return renderUploadQuestCard(q, idx, done, quests.length);
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
  initWatchGuards();
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
  const vid = APP.questVideos[questKey(currentLevel, idx + 1)] || {};
  const ytId = extractYouTubeId(vid.url);
  let player;
  if (!vid.url) {
    player = `<div class="qv-watch-link qv-disabled">📹 Video not uploaded yet — check back soon</div>`;
  } else if (ytId) {
    player = `<div class="qv-video-frame" id="yt-guard-${idx}" data-yt-id="${ytId}" data-idx="${idx}"></div>
      <div class="qv-note" id="qv-watch-note-${idx}">▶️ Watch the full video to unlock the complete button — skipping ahead will jump you back.</div>`;
  } else {
    player = `<a class="qv-watch-link" href="${vid.url}" target="_blank" rel="noopener">▶️ Watch Video${vid.title ? ' — ' + escapeHtml(vid.title) : ''}</a>`;
  }
  const unlocked = done || !ytId || isWatchUnlocked(idx);
  const btnLocked = !!ytId && !done && !unlocked;
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
      <button class="qv-complete-btn${done ? ' qv-done' : ''}${btnLocked ? ' qv-btn-disabled' : ''}"
        id="qv-complete-btn-${idx}" ${btnLocked ? 'disabled' : ''} onclick="toggleQuestSelf(${idx})">
        ${done ? '✓ Marked as watched — tap to undo' : (btnLocked ? '🔒 Watch the full video to unlock' : 'Mark as Watched — Complete')}
      </button>
    </div>`;
}

function renderUploadQuestCard(q, idx, done, totalInLevel) {
  const sid = APP.currentStudent['Student ID'];
  const inputId = `qv-file-${idx}`;
  const submittedUrl = (APP.videoSubmissions && APP.videoSubmissions[questKey(currentLevel, idx + 1)]) || '';
  const bodyContent = (done && submittedUrl)
    ? `<a class="qv-watch-link" href="${submittedUrl}" target="_blank" rel="noopener">🎬 View your submitted video</a>
       <label class="qv-replace-link" for="${inputId}">Replace video</label>`
    : `<label class="qv-upload-zone" for="${inputId}">📤 Tap to choose your testimony video<br><span>MP4/MOV, up to ${Math.round(MAX_UPLOAD_BYTES/1024/1024)}MB, max 2 minutes</span></label>`;
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

function showSentToast() {
  const toast = document.getElementById('stu-sent-toast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// ═══════════════════════════════════════════
// LEVEL CHALLENGE — VIDEO TESTIMONY UPLOAD
// ═══════════════════════════════════════════
// Raw file cap. Base64 adds ~33% on top of this when sent to Apps Script,
// which caps incoming web-app requests around ~50MB. Videos are capped at
// 2 minutes max, which keeps files naturally small — 15MB leaves comfortable
// headroom while still avoiding large-payload upload failures.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_TESTIMONY_SECONDS = 120;

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
    <div id="qv-submit-wrap-${idx}"><button class="qv-complete-btn" onclick="submitTestimony(${idx})">Submit Testimony</button></div>`;

  // Hard duration check — video must be 2 minutes or under. Some mobile
  // browsers/formats won't report duration reliably, so we only block when
  // we can actually confirm it's too long; otherwise we let it through.
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.onloadedmetadata = () => {
    const durEl = document.getElementById(`qv-dur-${idx}`);
    const submitWrap = document.getElementById(`qv-submit-wrap-${idx}`);
    if (isFinite(probe.duration) && probe.duration > 0 && probe.duration > MAX_TESTIMONY_SECONDS) {
      if (durEl) {
        durEl.className = 'qv-error';
        durEl.textContent = `This clip is about ${Math.round(probe.duration)}s — the task asks for a maximum of 2 minutes. Please trim it or record a shorter one, then choose it again.`;
      }
      if (submitWrap) submitWrap.innerHTML = '';
      delete pendingVideoFiles[idx];
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
    const base64 = await fileToBase64(file);
    const quest = questsForLevel(currentLevel)[idx];
    const result = await uploadTestimonyXHR({
      studentId: sid,
      studentName: s['Full Name'] || '',
      tableNo: s['Table No'] || '',
      levelNo: currentLevel,
      questNo: questNo,
      questTitle: quest ? quest.title : 'Video Testimony',
      levelName: LEVEL_NAMES[currentLevel] || '',
      fileName: file.name,
      mimeType: file.type || 'video/mp4',
      base64Data: base64,
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
    const detail = (e && e.message) ? e.message : 'Unknown error';
    if (statusEl) statusEl.innerHTML = `<div class="qv-error">Upload failed: ${escapeHtml(detail)}<br>Check your connection and try again. If your video is large, try trimming it shorter first.</div>
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

function uploadTestimonyXHR(payload, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', GAS_URL, true);
    xhr.timeout = 5 * 60 * 1000; // large uploads on slow connections need room
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
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
// INIT — pre-load students/table guides in the background so login is fast
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadStaticData().catch(e => console.warn('Initial data load failed (will retry on login):', e));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
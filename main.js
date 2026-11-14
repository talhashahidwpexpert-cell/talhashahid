/**
 * WorkLog desktop tracker – main process (Windows + macOS)
 * - signs in with the same account as the web dashboard
 * - records time on the project the manager assigned (no project picking)
 * - takes screenshots at random moments in each interval when the company enables it
 * - pauses on screen lock / sleep, detects idle time, works offline and syncs later
 */
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, desktopCapturer, screen, nativeImage, shell, safeStorage, systemPreferences, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
// The server has an IPv4 and an IPv6 address, and many internet connections cannot reach IPv6.
// By default the runtime gives the first address only 250 ms. On a slow line that is not enough: it then
// switches to the unreachable IPv6 address and the request fails after 10 s, so screenshots kept retrying.
// Fix: try IPv4 first and give it 5 s before moving on.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}
try { require('net').setDefaultAutoSelectFamilyAttemptTimeout(5000); } catch (e) {}

const APP_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'config.json'), 'utf8'));
const DATA = app.getPath('userData');
const STATE_FILE = path.join(DATA, 'state.json');
const PENDING_DIR = path.join(DATA, 'pending-shots');
const BEAT_MS = (APP_CFG.heartbeatSeconds || 60) * 1000;

let win = null, tray = null, quitting = false;

// ------------------------------------------------------------------ persistent state
const S = {
  server: APP_CFG.defaultServer || '',
  email: '',
  tokenEnc: null,          // token, encrypted with the OS keychain when available
  config: null,            // last config from server (user, project, screenshot policy …)
  status: 'stopped',       // stopped | running | break
  entry: null,             // { uuid, startedAt }
  breakStartedAt: null,
  autoPaused: false,       // paused because the screen locked / computer slept
  queue: [],               // offline queue of API calls
  todayBase: 0, todayAt: 0, // fallback for servers older than 1.2
  srvToday: null,          // { done, openUuid, openStart, dayStart, dayEnd } from the server
  todayStatic: 0,          // "Today" while not running
  lastShotAt: null, lastShotThumb: null, nextShotAt: null, windowEnd: null,
  idleSince: null, idlePrompt: null,
  online: true, lastError: '',
  autoLaunch: true,
};
function load() {
  try { Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { /* first run */ }
  S.idlePrompt = null;
}
let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  try {
    const copy = { ...S, lastShotThumb: null, idlePrompt: null };
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(copy));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { /* disk full / locked – try again on next change */ }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 200); }
function setToken(t) {
  if (!t) { S.tokenEnc = null; return; }
  S.tokenEnc = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(t).toString('base64') : 'raw:' + Buffer.from(t).toString('base64');
}
function getToken() {
  if (!S.tokenEnc) return null;
  try {
    const [kind, b64] = S.tokenEnc.split(':');
    return kind === 'enc' ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : Buffer.from(b64, 'base64').toString();
  } catch (e) { return null; }
}
const nowSec = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ server API
function apiUrl(p) { return S.server.replace(/\/+$/, '') + '/api/' + p; }
/**
 * opts.raw: { data: Buffer, type: 'image/jpeg' } sends a raw body – screenshots go this way, because many hosting
 * firewalls block multipart file uploads. opts.timeout in ms.
 */
async function api(method, p, body, opts = {}) {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'WorkLogTracker/' + app.getVersion() };
  const tok = getToken();
  if (tok) { headers['Authorization'] = 'Bearer ' + tok; headers['X-Auth-Token'] = tok; }
  let payload;
  if (opts.raw) { headers['Content-Type'] = opts.raw.type; payload = opts.raw.data; }
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
  try {
    const res = await fetch(apiUrl(p), { method, headers, body: payload, signal: ctrl.signal });
    let data = {};
    try { data = await res.json(); } catch (e) { data = { error: 'Unexpected answer from server (' + res.status + ')' }; }
    return { status: res.status, data };
  } finally { clearTimeout(t); }
}
function applyConfig(c) {
  if (!c || !c.user) return;
  const before = S.config && S.config.screenshots;
  S.config = { user: c.user, company: c.company, project: c.project, task: c.task, screenshots: c.screenshots, idle_minutes: c.idle_minutes, idle_action: c.idle_action || 'count', policy: c.policy, pending_invites: c.pending_invites || 0 };
  // removed from the company / switched company → stop the local timer
  if (!c.company && S.status !== 'stopped') { S.status = 'stopped'; S.entry = null; S.breakStartedAt = null; S.nextShotAt = null; updateTray(); }
  if (typeof c.today_seconds === 'number') { S.todayBase = c.today_seconds; S.todayAt = Date.now(); }
  if (typeof c.today_done_seconds === 'number') {
    S.srvToday = { done: c.today_done_seconds, openUuid: c.open_entry ? c.open_entry.uuid : null, openStart: c.open_entry ? c.open_entry.started_at : null,
      dayStart: c.day_start, dayEnd: c.day_end, total: c.today_seconds };
  } else S.srvToday = null;
  // while stopped, the server's figure is the truth once nothing is waiting to be sent
  if (S.status !== 'running' && !S.queue.some(q => q.type === 'api') && typeof c.today_seconds === 'number') S.todayStatic = c.today_seconds;
  // screenshot policy changed → reschedule
  if (!before || before.enabled !== c.screenshots.enabled || before.interval_min !== c.screenshots.interval_min) planNextShot(true);
  save(); push();
}

// ------------------------------------------------------------------ offline-safe queue
// Timer events (start / beat / stop) always go before screenshots, so a slow or failing upload never holds back the time.
function enqueue(item) { S.queue.push({ ...item, tries: 0 }); save(); flushSoon(); }
function dropItem(it) { const i = S.queue.indexOf(it); if (i >= 0) S.queue.splice(i, 1); }
function nextItem() { return S.queue.find(q => q.type !== 'shot') || S.queue[0]; }
let flushing = false, flushTimer = null;
function flushSoon(ms = 300) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }
async function flush() {
  if (flushing || !getToken()) return;
  flushing = true;
  try {
    while (S.queue.length) {
      const it = nextItem();
      let r;
      try {
        if (it.type === 'shot') {
          const file = path.join(PENDING_DIR, it.file);
          // give up on screenshots that could not be sent for a day (the time itself is never dropped)
          if (!fs.existsSync(file) || nowSec() - it.taken_at > 86400 || it.tries > 40) { try { fs.unlinkSync(file); } catch (e) {} dropItem(it); save(); continue; }
          const q = new URLSearchParams({ uuid: it.uuid, taken_at: String(it.taken_at), activity: String(it.activity), screen: String(it.screen) });
          r = await api('POST', 'screenshot?' + q.toString(), null, { raw: { data: fs.readFileSync(file), type: 'image/jpeg' }, timeout: 120000 });
          if (r.status === 200 || (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429)) { try { fs.unlinkSync(file); } catch (e) {} }
          if (r.status === 200) { S.shotError = ''; S.lastShotSent = nowSec(); }
          else if (r.status >= 400) S.shotError = 'Screenshot not accepted (' + r.status + ')';
        } else {
          r = await api('POST', it.path, it.body);
        }
      } catch (e) {
        it.tries++;
        if (it.type === 'shot') {
          // a slow or failed screenshot upload never marks the app offline and never holds back the time
          S.shotError = 'Screenshot upload failed – retrying';
          save();
          if (S.queue.some(q => q.type !== 'shot')) continue;
          flushSoon(Math.min(60000, 5000 * it.tries)); push();
          return;
        }
        S.online = false; S.lastError = 'No connection – your time is saved on this computer and sent as soon as you are online.';
        push(); flushSoon(Math.min(20000, 3000 * it.tries));
        return;
      }
      S.online = true; S.lastError = '';
      if (r.status === 401) { signOut('Your session ended. Please sign in again.'); return; }
      if (r.data && r.data.code === 'stop') {
        // the server says this timer no longer belongs to the person's company
        S.queue = S.queue.filter(q => q.uuid !== it.uuid);
        if (S.entry && S.entry.uuid === it.uuid) { S.entry = null; S.status = 'stopped'; S.nextShotAt = null; S.lastError = r.data.error || 'Timer stopped.'; updateTray(); }
        if (r.data.user) applyConfig(r.data);
        save(); continue;
      }
      if (r.status === 429) { flushSoon(60000); return; }
      if (r.status >= 500) {
        it.tries++;
        if (it.tries > 20) dropItem(it);
        save();
        // a failing screenshot must not stop the timer events queued behind it
        if (it.type === 'shot' && S.queue.some(q => q.type !== 'shot')) continue;
        flushSoon(Math.min(120000, 5000 * it.tries)); return;
      }
      // the server does not know this timer (its start was lost) → create it again with the original start time, then retry
      if (r.status === 404 && r.data && r.data.code === 'unknown_entry' && it.body && it.body.started_at && !it.recovered) {
        it.recovered = true;
        S.queue.unshift({ type: 'api', path: 'entry/start', uuid: it.uuid, body: { uuid: it.uuid, started_at: it.body.started_at }, tries: 0 });
        save(); continue;
      }
      dropItem(it);
      if (r.status === 200 && r.data) {
        // the manager switched the project while the timer runs → follow the new timer id
        if (r.data.uuid && S.entry && it.uuid === S.entry.uuid && r.data.uuid !== S.entry.uuid) {
          const old = S.entry.uuid;
          S.entry.uuid = r.data.uuid;
          S.queue.forEach(q => { if (q.uuid === old) { q.uuid = r.data.uuid; if (q.body) q.body.uuid = r.data.uuid; } });
        }
        if (r.data.user) applyConfig(r.data);
      }
      save();
    }
  } finally { flushing = false; push(); }
}

// ------------------------------------------------------------------ timer
function idleSeconds() { try { return powerMonitor.getSystemIdleTime(); } catch (e) { return 0; } }
function idleLimit() { return Math.max(60, ((S.config && S.config.idle_minutes) || 5) * 60); }

function startWork() {
  if (!S.config || S.status === 'running') return;
  if (!S.config.company || !S.config.policy.accepted) return;
  const uuid = crypto.randomUUID();
  S.todayStatic = currentToday();
  S.entry = { uuid, startedAt: nowSec(), idleAcc: 0, lastBeat: nowSec(), baseToday: S.todayStatic };
  S.status = 'running'; S.breakStartedAt = null; S.autoPaused = false; S.idleSince = null;
  enqueue({ type: 'api', path: 'entry/start', uuid, body: { uuid, started_at: S.entry.startedAt } });
  planNextShot(true);
  push(); updateTray();
}
function endEntry(at, reason) {
  if (!S.entry) return;
  const e = S.entry;
  const end = at || nowSec();
  // freeze today's total locally (the server confirms it once the stop is delivered)
  S.todayStatic = currentToday() - Math.max(0, nowSec() - end);
  enqueue({ type: 'api', path: 'entry/stop', uuid: e.uuid, body: { uuid: e.uuid, ended_at: end, started_at: e.startedAt, idle_sec: e.idleAcc || 0, reason: reason || 'stop' } });
  S.todayBase = S.todayStatic; S.todayAt = Date.now();
  S.entry = null;
}
function takeBreak(auto) {
  if (S.status !== 'running') return;
  endEntry(null, auto ? 'locked' : 'break');
  S.status = 'break'; S.breakStartedAt = nowSec(); S.autoPaused = auto ? 'lock' : false;
  S.nextShotAt = null;
  push(); updateTray();
}
/** No keyboard/mouse for the company's limit: stop the timer at the moment the inactivity began */
function pauseForIdle(idleFrom) {
  if (S.status !== 'running' || !S.entry) return;
  const from = Math.max(S.entry.startedAt, idleFrom);
  endEntry(from, 'idle');
  S.status = 'break'; S.breakStartedAt = from; S.autoPaused = 'idle'; S.nextShotAt = null; S.idleSince = null; S.idleWoke = false;
  const mins = Math.max(1, Math.round((nowSec() - from) / 60));
  const resumeAuto = ((S.config && S.config.idle_action) || 'pause') === 'pause';
  try { new Notification({ title: 'WorkLog paused', body: `No activity for ${mins} min – these minutes are not counted. ` + (resumeAuto ? 'Move the mouse to continue.' : 'Press Resume when you are back.') }).show(); } catch (e) {}
  push(); updateTray();
}
function stopWork() {
  if (S.status === 'running') endEntry(null, 'stop');
  else if (S.status === 'break') enqueue({ type: 'api', path: 'state', body: { state: 'stopped' } });
  S.status = 'stopped'; S.breakStartedAt = null; S.autoPaused = false; S.nextShotAt = null;
  push(); updateTray();
}
/**
 * Today's total. While running: time the server already counts as finished today + the running session,
 * so "Today" always moves together with the session clock.
 */
function currentToday() {
  const now = nowSec();
  if (S.status === 'running' && S.entry) {
    const t = S.srvToday;
    if (t && now < t.dayEnd) {
      let base = t.done, from = S.entry.startedAt;
      if (t.openUuid && t.openUuid.slice(0, 36) === S.entry.uuid.slice(0, 36)) from = t.openStart; // manager switched project: the earlier part is in "done"
      else if (t.openUuid) base = t.total || t.done; // an earlier timer whose stop has not reached the server yet
      return base + Math.max(0, now - Math.max(from, t.dayStart));
    }
    if (t && now >= t.dayEnd) return Math.max(0, now - Math.max(S.entry.startedAt, t.dayEnd)); // after midnight, until the next refresh
    // older server: last reported total + time since then
    return (S.entry.baseToday || 0) + Math.max(0, now - S.entry.startedAt);
  }
  return S.todayStatic;
}

// heartbeat every minute: keeps the server timer alive, reports idle time, refreshes the assigned project
setInterval(() => {
  if (S.status !== 'running' || !S.entry) return;
  const idle = idleSeconds();
  const since = nowSec() - (S.entry.lastBeat || nowSec());
  const idleDelta = idle >= idleLimit() ? Math.min(since, idle) : 0;
  S.entry.lastBeat = nowSec();
  // long idle → remember when it started, ask when the person comes back
  if (idle >= idleLimit() && !S.idleSince) S.idleSince = nowSec() - idle;
  // only one heartbeat waits in the queue while offline: the newest one carries all the information
  S.queue = S.queue.filter(q => !(q.path === 'entry/beat' && q.uuid === S.entry.uuid && !q.body.idle_sec));
  enqueue({ type: 'api', path: 'entry/beat', uuid: S.entry.uuid, body: { uuid: S.entry.uuid, at: nowSec(), started_at: S.entry.startedAt, idle_sec: idleDelta } });
  S.entry.idleAcc = 0;
}, BEAT_MS);

// inactivity check every 5 s – what happens is set by the company (Settings → Working hours)
function idleAction() { return (S.config && S.config.idle_action) || 'pause'; }
setInterval(() => {
  const idle = idleSeconds();
  const action = idleAction();
  // pause the timer when nobody has touched keyboard or mouse for the limit
  if (S.status === 'running' && action !== 'count' && idle >= idleLimit()) { pauseForIdle(nowSec() - idle); return; }
  // back after an inactivity pause
  if (S.status === 'break' && S.autoPaused === 'idle' && idle < 5) {
    if (action === 'pause') {
      startWork();
      try { new Notification({ title: 'WorkLog', body: 'Welcome back – your timer continues.' }).show(); } catch (e) {}
    } else if (!S.idleWoke) { S.idleWoke = true; showWindow(); push(); }
    return;
  }
  // "keep counting" mode: ask about long away periods when the person comes back
  if (action === 'count' && S.status === 'running' && S.idleSince && idle < 10) {
    const away = nowSec() - S.idleSince;
    if (away >= Math.max(600, idleLimit() * 2)) { S.idlePrompt = { from: S.idleSince, minutes: Math.round(away / 60) }; showWindow(); }
    S.idleSince = null; push();
  }
}, 5000);

// refresh assignment/config even when not tracking. Every 60 s when not tracking, so the dashboard shows the person as online;
// while tracking the heartbeats carry the config. Every 30 s while waiting to join a company.
let lastRefresh = 0;
setInterval(async () => {
  if (!getToken() || S.queue.some(q => q.type === 'api')) return;
  const every = (S.config && !S.config.company) ? 30000 : S.status === 'running' ? (APP_CFG.configRefreshSeconds || 180) * 1000 : 60000;
  if (Date.now() - lastRefresh < every) return;
  lastRefresh = Date.now();
  try { const r = await api('GET', 'me'); if (r.status === 200) { S.online = true; applyConfig(r.data); } else if (r.status === 401) signOut('Your session ended. Please sign in again.'); }
  catch (e) { S.online = false; push(); }
}, 10000);

// ------------------------------------------------------------------ screenshots
function shotsEnabled() { return !!(S.config && S.config.screenshots && S.config.screenshots.enabled && S.config.policy.accepted); }
function planNextShot(newWindow) {
  if (!shotsEnabled() || S.status !== 'running') { S.nextShotAt = null; return; }
  const iv = Math.max(1, S.config.screenshots.interval_min) * 60;
  const start = newWindow || !S.windowEnd ? nowSec() : S.windowEnd;
  S.windowEnd = start + iv;
  // random moment inside the window, not in the first/last 10 seconds
  S.nextShotAt = start + 10 + Math.floor(Math.random() * Math.max(1, iv - 20));
}
function screenPermissionOk() {
  if (process.platform !== 'darwin') return true;
  // 'not-determined' is allowed: the first capture makes macOS ask the person for permission
  try { return !['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen')); } catch (e) { return true; }
}
async function captureNow() {
  const displays = S.config.screenshots.all_screens ? screen.getAllDisplays() : [screen.getPrimaryDisplay()];
  const maxW = Math.max(...displays.map(d => Math.round(d.size.width * (d.scaleFactor || 1))));
  const maxH = Math.max(...displays.map(d => Math.round(d.size.height * (d.scaleFactor || 1))));
  const scale = Math.min(1, 1600 / maxW); // small enough to upload quickly on a slow connection
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(maxW * scale), height: Math.round(maxH * scale) } });
  const wanted = S.config.screenshots.all_screens ? sources : sources.filter(s => String(s.display_id) === String(screen.getPrimaryDisplay().id)).slice(0, 1);
  const list = wanted.length ? wanted : sources.slice(0, 1);
  const activity = Math.max(0, Math.min(100, 100 - Math.round(Math.min(idleSeconds(), 600) / 6)));
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  let n = 0;
  for (const src of list) {
    if (src.thumbnail.isEmpty()) continue;
    n++;
    const jpg = src.thumbnail.toJPEG(62);
    const name = crypto.randomUUID() + '.jpg';
    fs.writeFileSync(path.join(PENDING_DIR, name), jpg);
    enqueue({ type: 'shot', file: name, uuid: S.entry.uuid, taken_at: nowSec(), activity, screen: n });
    if (n === 1) S.lastShotThumb = src.thumbnail.resize({ width: 320 }).toDataURL();
  }
  if (n) S.lastShotAt = nowSec();
}
setInterval(async () => {
  if (S.status !== 'running' || !S.entry) return;
  if (!shotsEnabled()) { S.nextShotAt = null; return; }
  if (!S.nextShotAt) planNextShot(true);
  if (nowSec() >= S.windowEnd) planNextShot(false);
  if (S.nextShotAt && nowSec() >= S.nextShotAt) {
    S.nextShotAt = null; // one per window
    if (idleSeconds() < 3600 && screenPermissionOk()) {
      try { await captureNow(); } catch (e) { S.lastError = 'Screenshot failed: ' + e.message; }
    }
    push();
  }
}, 2000);

// ------------------------------------------------------------------ lock / sleep → automatic break
function onAway() { if (S.status === 'running') takeBreak(true); }
function onBack() {
  if (S.status === 'break' && (S.autoPaused === 'lock' || S.autoPaused === true)) {
    startWork();
    try { new Notification({ title: 'WorkLog', body: 'Welcome back – your timer continues.' }).show(); } catch (e) {}
  }
}

// ------------------------------------------------------------------ sign in / out
async function signIn({ server, email, password, code }) {
  server = String(server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(server)) server = 'https://' + server;
  if (/^http:\/\//i.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(server)) return { error: 'Please use the secure https:// address of your dashboard.' };
  S.server = server; S.email = String(email || '').trim();
  let r;
  try { r = await api('POST', 'login', { email: S.email, password, code: code || '', device: `${os.hostname()} · ${process.platform === 'darwin' ? 'macOS' : 'Windows'}` }); }
  catch (e) { return { error: 'Cannot reach ' + server + '. Check the address and your internet connection.' }; }
  if (r.status !== 200 || !r.data.token) return { error: (r.data && r.data.error) || 'Sign-in failed', needCode: !!(r.data && r.data.code === 'totp_required') };
  setToken(r.data.token);
  applyConfig(r.data);
  save(); push(); updateTray();
  return { ok: true };
}
function signOut(msg) {
  if (S.status === 'running') endEntry(null, 'stop');
  const tok = getToken();
  if (tok && !msg) api('POST', 'logout').catch(() => {});
  setToken(null);
  S.config = null; S.status = 'stopped'; S.entry = null; S.queue = S.queue.filter(q => q.type !== 'shot');
  S.lastError = msg || '';
  save(); push(); updateTray();
}

// ------------------------------------------------------------------ UI state → renderer
function publicState() {
  const signedIn = !!getToken() && !!S.config;
  let shotInfo = null;
  if (signedIn) {
    shotInfo = { enabled: !!(S.config.screenshots && S.config.screenshots.enabled), interval: S.config.screenshots ? S.config.screenshots.interval_min : 0,
      nextIn: S.nextShotAt ? Math.max(0, S.nextShotAt - nowSec()) : null, lastAt: S.lastShotAt, lastThumb: S.lastShotThumb, permission: screenPermissionOk() };
  }
  return {
    signedIn, server: S.server, email: S.email, config: S.config, status: S.status,
    startedAt: S.entry ? S.entry.startedAt : null, breakStartedAt: S.breakStartedAt, autoPaused: S.autoPaused,
    today: currentToday(), online: S.online, pending: S.queue.length, error: S.lastError,
    pendingTime: S.queue.filter(q => q.type !== 'shot').length, pendingShots: S.queue.filter(q => q.type === 'shot').length, shotError: S.shotError || '',
    idleAction: idleAction(), idleMinutes: Math.round(idleLimit() / 60),
    shots: shotInfo, idlePrompt: S.idlePrompt, autoLaunch: S.autoLaunch, platform: process.platform, version: app.getVersion(),
  };
}
function push() { if (win && !win.isDestroyed()) win.webContents.send('state', publicState()); }
setInterval(push, 1000);

ipcMain.handle('state', () => publicState());
ipcMain.handle('login', (e, a) => signIn(a));
ipcMain.handle('logout', () => { signOut(); return true; });
ipcMain.handle('acceptPolicy', async () => {
  try {
    const r = await api('POST', 'accept-policy');
    if (r.status !== 200) return { error: r.data.error || 'Could not save' };
    S.config.policy.accepted = true; save(); push(); return { ok: true };
  } catch (e) { return { error: 'No connection. Please try again.' }; }
});
ipcMain.handle('start', () => { startWork(); return true; });
ipcMain.handle('break', () => { takeBreak(false); return true; });
ipcMain.handle('stop', () => { stopWork(); return true; });
ipcMain.handle('resolveIdle', (e, choice) => {
  const p = S.idlePrompt; S.idlePrompt = null;
  if (p && choice === 'discard' && S.status === 'running') { endEntry(p.from, 'stop'); S.status = 'stopped'; startWork(); }
  push(); return true;
});
ipcMain.handle('openDashboard', () => shell.openExternal(S.server));
ipcMain.handle('openScreenSettings', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));
ipcMain.handle('setAutoLaunch', (e, on) => { S.autoLaunch = !!on; applyAutoLaunch(); save(); return true; });
ipcMain.handle('sync', () => { flushSoon(0); return true; });

function applyAutoLaunch() {
  try { app.setLoginItemSettings({ openAtLogin: S.autoLaunch, openAsHidden: true, args: ['--hidden'] }); } catch (e) {}
}

// ------------------------------------------------------------------ window & tray
function trayIcon(active) {
  const f = path.join(__dirname, 'assets', active ? 'tray-active.png' : (process.platform === 'darwin' ? 'tray.png' : 'tray-win.png'));
  const src = nativeImage.createFromPath(f);
  if (src.isEmpty()) return nativeImage.createEmpty();
  const img = src.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
  if (process.platform === 'darwin') img.setTemplateImage(!active);
  return img;
}
function updateTray() {
  if (!tray) return;
  const running = S.status === 'running';
  tray.setImage(trayIcon(running));
  tray.setToolTip('WorkLog – ' + (running ? 'tracking' + (S.config && S.config.project ? ': ' + S.config.project.name : '') : S.status === 'break' ? 'on break' : 'stopped'));
  const signedIn = !!getToken() && !!S.config;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WorkLog', click: showWindow },
    { type: 'separator' },
    { label: 'Start', enabled: signedIn && !running && !!(S.config && S.config.company && S.config.policy.accepted), click: startWork },
    { label: 'Take a break', enabled: running, click: () => takeBreak(false) },
    { label: 'Stop for today', enabled: S.status !== 'stopped', click: stopWork },
    { type: 'separator' },
    { label: 'Open dashboard', enabled: !!S.server, click: () => shell.openExternal(S.server) },
    { label: 'Quit WorkLog', click: () => { quitting = true; app.quit(); } },
  ]));
}
function showWindow() {
  if (!win) createWindow();
  win.show(); win.focus();
}
function createWindow() {
  win = new BrowserWindow({
    width: 400, height: 640, minWidth: 360, minHeight: 560, resizable: true, maximizable: false, show: false,
    title: 'WorkLog', backgroundColor: '#0b1220', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ app lifecycle
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    load();
    if (process.platform === 'win32') app.setAppUserModelId('com.worklog.tracker');
    // after a crash/restart while running: the old timer was closed by the server – start fresh only if it was running
    if (S.status === 'running' && S.entry) { endEntry(S.entry.lastBeat || S.entry.startedAt, 'stop'); S.status = 'stopped'; }
    tray = new Tray(trayIcon(false));
    tray.on('click', showWindow);
    createWindow();
    updateTray();
    applyAutoLaunch();
    powerMonitor.on('lock-screen', onAway);
    powerMonitor.on('suspend', onAway);
    powerMonitor.on('unlock-screen', onBack);
    powerMonitor.on('resume', onBack);
    powerMonitor.on('shutdown', () => { stopWork(); });
    flushSoon(1000);
    if (getToken()) api('GET', 'me').then(r => { if (r.status === 200) applyConfig(r.data); else if (r.status === 401) signOut('Your session ended. Please sign in again.'); }).catch(() => { S.online = false; });
  });
  app.on('activate', showWindow);
  app.on('window-all-closed', (e) => { /* keep running in the tray */ });
  let finalFlushDone = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (finalFlushDone) return;
    e.preventDefault();
    if (S.status === 'running') stopWork();
    saveNow();
    // give the queue up to 4 seconds to reach the server, the rest is sent on next start
    Promise.race([flush(), new Promise(r => setTimeout(r, 4000))]).finally(() => { saveNow(); finalFlushDone = true; app.quit(); });
  });
}

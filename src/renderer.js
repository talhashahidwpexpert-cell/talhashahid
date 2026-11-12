'use strict';
/* WorkLog tracker window */
const $ = (id) => document.getElementById(id);
const W = window.worklog;
let st = null;

const pad = (n) => String(n).padStart(2, '0');
const hms = (s) => { s = Math.max(0, Math.floor(s)); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60); };
const hm = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 3600) + 'h ' + pad(Math.floor(s % 3600 / 60)) + 'm'; };
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const show = (id) => ['v-login', 'v-wait', 'v-policy', 'v-main'].forEach(v => { $(v).hidden = v !== id; });

function render(s) {
  st = s;
  if (!s.signedIn) {
    show('v-login');
    if (!$('l-server').value) $('l-server').value = s.server || '';
    if (!$('l-email').value) $('l-email').value = s.email || '';
    if (s.error) { $('l-error').textContent = s.error; $('l-error').hidden = false; }
    return;
  }
  const c = s.config;
  if (!c.company) {
    show('v-wait');
    $('w-name').textContent = c.user.name;
    $('w-email').textContent = c.user.email;
    $('w-invites').hidden = !c.pending_invites;
    $('w-invites').textContent = c.pending_invites ? `You have ${c.pending_invites} invitation${c.pending_invites > 1 ? 's' : ''} waiting – accept on the dashboard.` : '';
    return;
  }
  if (!c.policy.accepted) {
    show('v-policy');
    $('p-company').textContent = c.company.name;
    $('p-text').textContent = c.policy.text;
    $('p-shots').textContent = c.screenshots.enabled ? `Screenshots: ON – about every ${c.screenshots.interval_min} minutes while the timer runs` : 'Screenshots: OFF for your team – only working time is recorded';
    $('p-shots').className = 'badge-line ' + (c.screenshots.enabled ? 'on' : 'off');
    return;
  }
  show('v-main');
  $('m-name').textContent = c.user.name;
  $('m-company').textContent = c.company.name;
  $('m-net').className = 'net ' + (s.online ? 'on' : 'off');
  $('m-net').title = s.online ? 'Connected' : 'Offline – time is saved and sent later';
  $('m-project').textContent = c.project ? c.project.name : 'No project assigned';
  $('m-color').style.background = c.project ? c.project.color : '#64748b';
  $('m-client').textContent = c.project ? [c.project.client || 'Internal', c.task && c.task.name].filter(Boolean).join(' · ') : 'Your time is still recorded – your manager can assign a project.';

  const now = Date.now() / 1000;
  const running = s.status === 'running';
  document.body.dataset.status = s.status;
  if (running) { $('m-state').textContent = '● Tracking'; $('m-timer').textContent = hms(now - s.startedAt); }
  else if (s.status === 'break') { $('m-state').textContent = s.autoPaused ? 'Paused – screen locked' : 'On break'; $('m-timer').textContent = hms(now - s.breakStartedAt); }
  else { $('m-state').textContent = 'Ready to start'; $('m-timer').textContent = '00:00:00'; }
  $('m-today').textContent = hm(s.today);
  $('b-start').textContent = s.status === 'break' ? '▶ Resume' : '▶ Start';
  $('b-start').hidden = running;
  $('b-break').hidden = !running;
  $('b-stop').hidden = s.status === 'stopped';

  const sh = s.shots;
  $('m-shots').className = 'card shots ' + (sh.enabled ? 'on' : 'off');
  if (!sh.enabled) { $('s-title').textContent = 'Screenshots off'; $('s-sub').textContent = 'Your company does not take screenshots for your team.'; }
  else {
    $('s-title').textContent = 'Screenshots on · every ~' + sh.interval + ' min';
    $('s-sub').textContent = running ? (sh.nextIn !== null ? 'Next one in about ' + Math.max(1, Math.ceil(sh.nextIn / 60)) + ' min' : 'Waiting for the next interval') : 'Only while the timer runs – never on breaks';
  }
  $('s-perm').hidden = !(sh.enabled && !sh.permission && s.platform === 'darwin');
  $('s-last').hidden = !(sh.enabled && sh.lastAt);
  if (sh.lastThumb) $('s-img').src = sh.lastThumb;
  if (sh.lastAt) $('s-when').textContent = 'Last screenshot ' + clock(sh.lastAt) + ' – you can see all of yours in the dashboard (if your company allows it).';

  $('m-sync').textContent = s.pending ? `${s.pending} item${s.pending > 1 ? 's' : ''} waiting to sync` + (s.online ? '…' : ' (offline)') : (s.error || 'All synced');
  $('m-sync').className = s.pending && !s.online ? 'warn-text' : '';
  $('m-ver').textContent = 'v' + s.version;
  $('m-autolaunch').checked = !!s.autoLaunch;

  $('idle').hidden = !s.idlePrompt;
  if (s.idlePrompt) $('idle-min').textContent = s.idlePrompt.minutes;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('l-error').hidden = true; $('l-btn').disabled = true; $('l-btn').textContent = 'Signing in…';
  const r = await W.login($('l-server').value, $('l-email').value, $('l-pass').value, $('l-code').value);
  $('l-btn').disabled = false; $('l-btn').textContent = 'Sign in';
  if (r.needCode) { $('l-code-wrap').hidden = false; $('l-code').required = true; $('l-code').focus(); }
  if (r.error) { $('l-error').textContent = r.error; $('l-error').hidden = false; }
  else { $('l-pass').value = ''; $('l-code').value = ''; $('l-code-wrap').hidden = true; }
  render(await W.state());
});
$('p-accept').addEventListener('click', async () => {
  const r = await W.acceptPolicy();
  if (r.error) { $('p-error').textContent = r.error; $('p-error').hidden = false; }
  render(await W.state());
});
$('p-logout').addEventListener('click', async () => { await W.logout(); render(await W.state()); });
$('w-logout').addEventListener('click', async () => { await W.logout(); render(await W.state()); });
$('w-open').addEventListener('click', () => W.openDashboard());
$('b-start').addEventListener('click', async () => { await W.start(); render(await W.state()); });
$('b-break').addEventListener('click', async () => { await W.takeBreak(); render(await W.state()); });
$('b-stop').addEventListener('click', async () => { if (confirm('Stop tracking for today?')) { await W.stop(); render(await W.state()); } });
$('idle-keep').addEventListener('click', async () => { await W.resolveIdle('keep'); render(await W.state()); });
$('idle-drop').addEventListener('click', async () => { await W.resolveIdle('discard'); render(await W.state()); });
$('s-perm-btn').addEventListener('click', () => W.openScreenSettings());
$('m-menu').addEventListener('click', (e) => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('menu').hidden = true; });
$('menu').addEventListener('click', async (e) => {
  const a = e.target.closest('button'); if (!a) return;
  $('menu').hidden = true;
  if (a.dataset.act === 'dashboard') W.openDashboard();
  if (a.dataset.act === 'sync') W.sync();
  if (a.dataset.act === 'logout' && confirm('Sign out of the tracker? A running timer will be stopped.')) { await W.logout(); render(await W.state()); }
});
$('m-autolaunch').addEventListener('change', (e) => W.setAutoLaunch(e.target.checked));

W.onState(render);
W.state().then(render);

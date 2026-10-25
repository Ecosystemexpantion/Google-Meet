// ─── Class page: class.html?e=<id> ────────────────────────
// Before the class: countdown, reminders, add to calendar, share. When the
// presenter opens the room it turns into "Live now — join"; someone who
// entered their name early is taken straight in.
//
// Reminders are push notifications (1 day, 1 hour, 10 minutes before and
// "live now"), sent by the classroom server; sw.js shows them. Tapping one
// opens this page with ?go=1, which joins as soon as the class is live.
import { api } from './live/api.js?v=__BUILD__';
import { $, h, icon, CFG, orbit, fmtDate, fmtTime, fmtZone, googleCalendar, downloadIcs, share, classUrl } from './site.js?v=__BUILD__';

const q = new URLSearchParams(location.search);
const id = q.get('e') || '';
const app = $('#app');
const chip = $('#chip');
let ev = null;
let live = false;
let waitingToJoin = false;
// reminders: 'on' | 'off' | 'busy' | 'unsupported' | 'ios' | 'blocked'
let reminders = 'off';
const REM_KEY = `eem26_rem_${id}`;
const remindBox = h('div', { class: 'remind' });
const clock = orbit();
const nameIn = h('input', { class: 'input', id: 'name', maxlength: 40, placeholder: 'Your name', autocomplete: 'name', value: localStorage.getItem('eem26_name') || '' });
const joinBtn = h('button', { class: 'btn primary lg block', id: 'join' });
const note = h('p', { class: 'fine' });
const panel = h('section', { class: 'panel glass reveal d1' });

function setChip(kind, text) {
  chip.className = `chip ${kind}`;
  chip.innerHTML = kind === 'live' ? `<span class="pulse"></span>${text}` : text;
}

function join() {
  const name = nameIn.value.trim();
  if (name.length < 2) { nameIn.focus(); nameIn.placeholder = 'Please enter your name'; return; }
  localStorage.setItem('eem26_name', name);
  if (!live) {
    waitingToJoin = true;
    render();
    if (reminders === 'off') enableReminders();
    return;
  }
  const q = new URLSearchParams({ rm: ev.room, n: name, t: ev.title, go: 1 });
  location.href = `room.html?${q}`;
}
joinBtn.addEventListener('click', join);
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

// ── Reminders ─────────────────────────────────────────────
function pushSupport() {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'yes';
  // iPhone/iPad: only from the Home Screen app (iOS 16.4+)
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'no';
}

async function registration() {
  return navigator.serviceWorker.register('sw.js', { scope: './' });
}

async function checkReminders() {
  const support = pushSupport();
  if (support !== 'yes') { reminders = support === 'ios' ? 'ios' : 'unsupported'; return; }
  if (Notification.permission === 'denied') { reminders = 'blocked'; return; }
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    reminders = sub && localStorage.getItem(REM_KEY) ? 'on' : 'off';
  } catch { reminders = 'off'; }
}

function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function enableReminders() {
  if (pushSupport() !== 'yes') { await checkReminders(); renderRemind(); return; }
  reminders = 'busy'; renderRemind();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { reminders = perm === 'denied' ? 'blocked' : 'off'; renderRemind(); return; }
    const { key } = await api('push-key');
    if (!key) throw new Error('Reminders aren’t available yet.');
    const reg = await registration();
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    await api('remind-add', { id, name: nameIn.value.trim(), sub: sub.toJSON() });
    localStorage.setItem(REM_KEY, '1');
    reminders = 'on';
  } catch (e) {
    console.warn('reminders', e);
    reminders = 'error';
  }
  renderRemind();
}

async function disableReminders() {
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) await api('remind-remove', { id, sub: sub.toJSON() });
  } catch { /* ignore */ }
  localStorage.removeItem(REM_KEY);
  reminders = 'off';
  renderRemind();
}

function renderRemind() {
  const cal = () => h('button', { class: 'linkish', onclick: () => downloadIcs(ev, classUrl(ev.id)) }, 'add it to your calendar');
  const views = {
    on: [h('span', { class: 'bell on', html: icon('bell', 18) }),
      h('div', {}, h('b', {}, 'Reminders are on'), h('span', {}, '1 day, 1 hour and 10 minutes before, and the moment it goes live. Tap the notification to join. '),
        h('button', { class: 'linkish', onclick: disableReminders }, 'Turn off'))],
    off: [h('span', { class: 'bell', html: icon('bell', 18) }),
      h('div', {}, h('b', {}, 'Get 3 reminders'), h('span', {}, '1 day, 1 hour and 10 minutes before — plus a tap-to-join alert when it starts. '),
        h('button', { class: 'linkish', id: 'remind', onclick: enableReminders }, 'Turn on reminders'))],
    busy: [h('span', { class: 'spin' }), h('div', {}, h('b', {}, 'Turning on reminders…'), h('span', {}, 'Tap “Allow” when your browser asks.'))],
    ios: [h('span', { class: 'bell', html: icon('bell', 18) }),
      h('div', {}, h('b', {}, 'Reminders on iPhone'), h('span', {}, 'Tap Share ', h('b', {}, '⎙'), ' → “Add to Home Screen”, open the class from there and tap Join — or '), cal(), h('span', {}, ' (3 alarms).'))],
    unsupported: [h('span', { class: 'bell', html: icon('bell', 18) }),
      h('div', {}, h('b', {}, 'Get reminded'), h('span', {}, 'This browser can’t show reminders — '), cal(), h('span', {}, ' instead (3 alarms).'))],
    blocked: [h('span', { class: 'bell', html: icon('bell', 18) }),
      h('div', {}, h('b', {}, 'Notifications are blocked'), h('span', {}, 'Allow notifications for this site in your browser settings, or '), cal(), h('span', {}, ' (3 alarms).'))],
    error: [h('span', { class: 'bell', html: icon('bell', 18) }),
      h('div', {}, h('b', {}, 'Couldn’t turn on reminders'), h('span', {}, 'Check your connection and '), h('button', { class: 'linkish', onclick: enableReminders }, 'try again'), h('span', {}, ', or '), cal(), h('span', {}, '.'))],
  };
  remindBox.className = `remind glass soft ${reminders}`;
  remindBox.replaceChildren(...(views[reminders] || views.off));
}

function phase() {
  const start = Date.parse(ev.startsAt);
  const end = start + ev.durationMin * 60e3;
  const now = Date.now();
  if (live) return 'live';
  if (now < start) return 'upcoming';
  if (now < end + 30 * 60e3) return 'starting';
  return 'ended';
}

function info() {
  const url = classUrl(ev.id);
  const initials = (CFG.PRESENTER_NAME || 'P').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return h('section', { class: 'reveal' },
    h('div', { class: 'eyebrow' }, 'Live class'),
    h('h1', { class: 'display' }, ev.title),
    ev.description ? h('p', { class: 'desc' }, ev.description) : null,
    h('div', { class: 'when glass soft' },
      h('span', { html: icon('calendar', 26) }),
      h('div', {}, h('b', {}, `${fmtDate(ev.startsAt)}`), h('span', {}, `${fmtTime(ev.startsAt)} ${fmtZone()} · ${ev.durationMin >= 60 ? `${+(ev.durationMin / 60).toFixed(1)} h` : `${ev.durationMin} min`}`))),
    h('div', { class: 'row' },
      h('a', { class: 'btn sm', href: googleCalendar(ev, url), target: '_blank', rel: 'noopener', html: `${icon('calendar', 16)}Google Calendar` }),
      h('button', { class: 'btn sm', onclick: () => downloadIcs(ev, url), html: `${icon('download', 16)}Apple / Outlook (3 alarms)` }),
      h('button', { class: 'btn sm', onclick: () => share(ev, url), html: `${icon('share', 16)}Share` })),
    h('div', { class: 'host' }, h('span', { class: 'av' }, initials), h('span', {}, 'Hosted by ', h('b', { style: 'color:var(--text)' }, CFG.PRESENTER_NAME || 'your presenter'))));
}

function render() {
  const p = phase();
  document.title = `${ev.title} · EEM26 Live`;
  panel.replaceChildren();
  if (p === 'live') {
    setChip('live', 'Live now');
    joinBtn.textContent = 'Join the class';
    joinBtn.disabled = false;
    note.textContent = 'You’ll join as a viewer. Raise your hand to speak.';
    panel.append(h('div', { class: 'live-ring' }, h('b', {}, 'LIVE')), h('div', { class: 'state-title' }, 'The class has started'),
      h('p', { class: 'state-sub' }, 'Enter your name and step in.'), nameIn, joinBtn, note);
    if (waitingToJoin && nameIn.value.trim().length >= 2) join();
    return;
  }
  if (p === 'ended') {
    setChip('done', 'Ended');
    panel.append(h('div', { class: 'state-title' }, 'This class has ended'), h('p', { class: 'state-sub' }, 'Thanks for your interest — watch out for the next one.'));
    return;
  }
  setChip(p === 'upcoming' ? 'soon' : 'live', p === 'upcoming' ? 'Upcoming' : 'Starting soon');
  joinBtn.textContent = waitingToJoin ? 'You’re on the list — waiting for the host…' : 'Remind me & join automatically';
  joinBtn.disabled = waitingToJoin;
  note.textContent = waitingToJoin
    ? 'Keep this page open and you’ll be taken in automatically — or tap a reminder later.'
    : 'Enter your name: we’ll remind you before it starts and take you in the moment it begins.';
  renderRemind();
  panel.append(clock.el, nameIn, joinBtn, note, remindBox);
  tick();
}

function tick() {
  if (!ev) return;
  const p = phase();
  if (p === 'upcoming') clock.set(Date.parse(ev.startsAt) - Date.now());
  else if (p === 'starting') clock.set(0, 'Any moment');
}

async function load() {
  try {
    const res = await api('event-info', { id });
    const was = ev ? phase() : null;
    ev = res.event;
    live = res.live;
    if (!app.children.length) app.append(info(), panel);
    if (was !== phase() || !panel.children.length) render();
  } catch (e) {
    setChip('done', 'Not found');
    app.replaceChildren(h('section', { class: 'panel glass', style: 'grid-column:1/-1;max-width:560px;margin:0 auto' },
      h('div', { class: 'state-title' }, e.status === 404 ? 'This class link isn’t valid' : 'Couldn’t load this class'),
      h('p', { class: 'state-sub' }, e.status === 404 ? 'Ask the presenter for a new link.' : 'Check your connection — we’ll keep trying.')));
    if (e.status !== 404) setTimeout(load, 8000);
    return;
  }
  // Check more often close to the start, so people get in as soon as it opens.
  const left = Date.parse(ev.startsAt) - Date.now();
  setTimeout(load, phase() === 'starting' || left < 3 * 60e3 ? 5000 : 30000);
}

setInterval(tick, 1000);
// Opened from a reminder (or "join" link) with the name already known: go
// straight in when the class is live, or wait here and join when it opens.
if (q.get('go') && nameIn.value.trim().length >= 2) waitingToJoin = true;
checkReminders().then(() => { if (ev && phase() !== 'live' && phase() !== 'ended') renderRemind(); });
if (!id) {
  setChip('done', 'Not found');
  app.append(h('section', { class: 'panel glass', style: 'grid-column:1/-1;max-width:560px;margin:0 auto' }, h('div', { class: 'state-title' }, 'No class selected'), h('p', { class: 'state-sub' }, 'Open the link the presenter shared with you.')));
} else load();

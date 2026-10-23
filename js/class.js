// ─── Class page: class.html?e=<id> ────────────────────────
// Before the class: countdown, add to calendar, share. When the presenter
// opens the room it turns into "Live now — join"; someone who entered their
// name early is taken straight in.
import { api } from './live/api.js?v=b85381e6';
import { $, h, icon, CFG, orbit, fmtDate, fmtTime, fmtZone, googleCalendar, downloadIcs, share, classUrl } from './site.js?v=b85381e6';

const id = new URLSearchParams(location.search).get('e') || '';
const app = $('#app');
const chip = $('#chip');
let ev = null;
let live = false;
let waitingToJoin = false;
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
    return;
  }
  const q = new URLSearchParams({ rm: ev.room, n: name, t: ev.title, go: 1 });
  location.href = `room.html?${q}`;
}
joinBtn.addEventListener('click', join);
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

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
      h('button', { class: 'btn sm', onclick: () => downloadIcs(ev, url), html: `${icon('download', 16)}Apple / Outlook` }),
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
  joinBtn.textContent = waitingToJoin ? 'You’re on the list — waiting for the host…' : 'Join when it starts';
  joinBtn.disabled = waitingToJoin;
  note.textContent = waitingToJoin ? 'Keep this page open. You’ll be taken in automatically.' : 'Enter your name now and we’ll take you in the moment it starts.';
  panel.append(clock.el, nameIn, joinBtn, note);
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
if (!id) {
  setChip('done', 'Not found');
  app.append(h('section', { class: 'panel glass', style: 'grid-column:1/-1;max-width:560px;margin:0 auto' }, h('div', { class: 'state-title' }, 'No class selected'), h('p', { class: 'state-sub' }, 'Open the link the presenter shared with you.')));
} else load();

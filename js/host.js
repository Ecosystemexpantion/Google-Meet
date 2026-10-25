// ─── Presenter: sign in, schedule classes, share links, start ─────
// The password is checked by the server (HOST_PASSWORD secret); it is kept in
// this device for 12 hours (see keep), so leaving the app doesn't sign out.
import { api, keep } from './live/api.js?v=__BUILD__';
import { $, h, icon, CFG, toast, fmtWhen, fmtZone, classUrl, copy, share, whatsapp } from './site.js?v=__BUILD__';

const main = $('#main');
const signout = $('#signout');
const KEY = 'eem26_host_pw';
let password = keep.get(KEY) || '';
let editing = null;

signout.innerHTML = `${icon('logout', 16)}Sign out`;
signout.onclick = () => { keep.del(KEY); keep.del('lv_host_live'); location.href = 'host.html'; };

// ── Sign in ───────────────────────────────────────────────
function showLogin(message) {
  signout.classList.add('hidden');
  const pass = h('input', { class: 'input', type: 'password', id: 'password-input', placeholder: 'Host password', autocomplete: 'current-password' });
  const err = h('div', { class: `alert${message ? '' : ' hidden'}`, role: 'alert' }, message || '');
  const btn = h('button', { class: 'btn primary lg block', id: 'auth-submit', type: 'submit' }, 'Continue');
  const form = h('form', { class: 'stack', novalidate: true }, h('label', { class: 'field' }, h('span', {}, 'Password'), pass), err, btn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = 'Checking…'; err.classList.add('hidden');
    try {
      await api('host-login', { password: pass.value });
      password = pass.value;
      keep.set(KEY, password);
      showDashboard();
    } catch (x) {
      err.textContent = x.status === 401 ? 'That password isn’t right — try again.' : `Couldn’t sign in: ${x.message}`;
      err.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Continue';
      pass.select();
    }
  };
  main.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card glass reveal' },
    h('img', { src: 'app/mark.svg', alt: '', width: 56, height: 56, style: 'border-radius:16px' }),
    h('div', {}, h('div', { class: 'eyebrow' }, 'Presenter'), h('h1', { class: 'display', style: 'margin-top:8px' }, 'Welcome back')),
    h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Sign in to schedule classes, share links and go live.'),
    form,
    h('a', { class: 'faint', href: 'index.html', style: 'font-size:13px;text-align:center' }, 'Joining as a student? Go to the class page →'))));
  setTimeout(() => pass.focus(), 50);
}

// ── Dashboard ─────────────────────────────────────────────
function studioUrl(ev) {
  const q = new URLSearchParams({ room: ev.room, title: ev.title, e: ev.id });
  return `host-room.html?${q}`;
}

function nextHour() {
  const d = new Date(Date.now() + 60 * 60e3);
  d.setMinutes(0, 0, 0);
  return d;
}
function toLocalInput(d) {
  const off = d.getTimezoneOffset() * 60e3;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

const form = {};
function scheduleCard() {
  form.title = h('input', { class: 'input', id: 'ev-title', maxlength: 120, placeholder: 'e.g. Selar Setup Training', value: CFG.CLASS_TITLE || '' });
  form.when = h('input', { class: 'input', id: 'ev-when', type: 'datetime-local', value: toLocalInput(nextHour()) });
  form.len = h('select', { class: 'input', id: 'ev-len' }, ...[[30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours']].map(([v, l]) => h('option', { value: v, selected: v === 60 }, l)));
  form.desc = h('textarea', { class: 'input', id: 'ev-desc', maxlength: 600, placeholder: 'What will people learn? (optional)' });
  form.err = h('div', { class: 'alert hidden', role: 'alert' });
  form.result = h('div');
  form.save = h('button', { class: 'btn primary block', id: 'ev-save', html: `${icon('calendar', 18)}Schedule class` });
  form.cancel = h('button', { class: 'btn block hidden', onclick: () => setEditing(null) }, 'Cancel editing');
  form.save.onclick = saveEvent;
  form.heading = h('div', { class: 'sec-title', html: `${icon('plus', 20)}Schedule a class` });
  return h('section', { class: 'card glass stack reveal d1' },
    form.heading,
    h('label', { class: 'field' }, h('span', {}, 'Title'), form.title),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, `Starts (${fmtZone()})`), form.when),
      h('label', { class: 'field' }, h('span', {}, 'Length'), form.len)),
    h('label', { class: 'field' }, h('span', {}, 'Description'), form.desc),
    form.err, form.save, form.cancel, form.result);
}

function setEditing(ev) {
  editing = ev;
  form.heading.innerHTML = `${icon(ev ? 'edit' : 'plus', 20)}${ev ? 'Edit class' : 'Schedule a class'}`;
  form.save.innerHTML = `${icon('calendar', 18)}${ev ? 'Save changes' : 'Schedule class'}`;
  form.cancel.classList.toggle('hidden', !ev);
  form.title.value = ev ? ev.title : CFG.CLASS_TITLE || '';
  form.when.value = toLocalInput(ev ? new Date(ev.startsAt) : nextHour());
  form.len.value = String(ev ? ev.durationMin : 60);
  if (ev && !form.len.value) form.len.append(h('option', { value: ev.durationMin, selected: true }, `${ev.durationMin} minutes`));
  form.desc.value = ev ? ev.description : '';
  form.result.replaceChildren();
  if (ev) form.title.focus();
}

async function saveEvent() {
  form.err.classList.add('hidden');
  const when = new Date(form.when.value);
  if (Number.isNaN(when.getTime())) { form.err.textContent = 'Choose a date and time.'; form.err.classList.remove('hidden'); return; }
  form.save.disabled = true;
  try {
    const { event } = await api('event-save', {
      password, id: editing?.id, title: form.title.value, startsAt: when.toISOString(), durationMin: Number(form.len.value), description: form.desc.value,
    });
    const wasEdit = !!editing;
    setEditing(null);
    form.result.replaceChildren(createdBox(event, wasEdit));
    loadList();
  } catch (x) {
    if (x.status === 401) return showLogin('Please sign in again.');
    form.err.textContent = x.message; form.err.classList.remove('hidden');
  } finally {
    form.save.disabled = false;
  }
}

function createdBox(ev, edited) {
  const url = classUrl(ev.id);
  return h('div', { class: 'created reveal' },
    h('div', {}, h('b', {}, edited ? 'Saved. ' : 'Scheduled! '), 'Share this link — it shows a countdown and lets people in when you start.'),
    h('div', { class: 'linkbox' }, h('span', {}, url), h('button', { class: 'btn sm primary', onclick: () => copy(url), html: `${icon('copy', 15)}Copy` })),
    h('div', { class: 'row' },
      h('a', { class: 'btn sm', href: whatsapp(ev, url), target: '_blank', rel: 'noopener', html: `${icon('whatsapp', 15)}WhatsApp` }),
      h('button', { class: 'btn sm', onclick: () => share(ev, url), html: `${icon('share', 15)}Share` }),
      h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener', html: `${icon('eye', 15)}Preview` })));
}

const listEl = h('div', { class: 'list' });
const pastEl = h('div', { class: 'list' });
const pastWrap = h('details', { class: 'hidden' }, h('summary', {}, 'Recent classes'), pastEl);

function item(ev, past) {
  const d = new Date(ev.startsAt);
  const url = classUrl(ev.id);
  const status = ev.live ? h('span', { class: 'chip live', html: '<span class="pulse"></span>Live' }) : null;
  return h('div', { class: 'item' },
    h('div', { class: 'datebox' }, h('b', {}, d.getDate()), h('span', {}, d.toLocaleDateString(undefined, { month: 'short' }))),
    h('div', { class: 'item-main' },
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('div', { class: 'item-title' }, ev.title), status),
      h('div', { class: 'item-sub' }, `${fmtWhen(ev.startsAt)} · ${ev.durationMin} min${ev.reminders ? ` · 🔔 ${ev.reminders} will be reminded` : ''}`)),
    h('div', { class: 'item-actions' },
      past ? null : h('a', { class: 'btn sm primary', href: studioUrl(ev), html: `${icon('play', 14)}${ev.live ? 'Rejoin' : 'Start'}` }),
      h('button', { class: 'btn sm icon', title: 'Copy link', 'aria-label': 'Copy link', onclick: () => copy(url), html: icon('link', 16) }),
      past ? null : h('a', { class: 'btn sm icon', title: 'Share on WhatsApp', 'aria-label': 'Share on WhatsApp', href: whatsapp(ev, url), target: '_blank', rel: 'noopener', html: icon('whatsapp', 16) }),
      past ? null : h('button', { class: 'btn sm icon', title: 'Edit', 'aria-label': 'Edit', onclick: () => { setEditing(ev); window.scrollTo({ top: 0, behavior: 'smooth' }); }, html: icon('edit', 16) }),
      h('button', { class: 'btn sm icon danger', title: 'Delete', 'aria-label': 'Delete', onclick: () => removeEvent(ev), html: icon('trash', 16) })));
}

async function removeEvent(ev) {
  if (!confirm(`Delete “${ev.title}”? Its link will stop working.`)) return;
  try { await api('event-delete', { password, id: ev.id }); toast('Class deleted'); loadList(); }
  catch (x) { if (x.status === 401) showLogin('Please sign in again.'); else toast(x.message); }
}

async function loadList() {
  try {
    const { events } = await api('event-list', { password });
    const now = Date.now();
    const ended = (e) => !e.live && Date.parse(e.startsAt) + e.durationMin * 60e3 + 30 * 60e3 < now;
    const upcoming = events.filter((e) => !ended(e));
    const past = events.filter(ended).reverse();
    listEl.replaceChildren(...(upcoming.length ? upcoming.map((e) => item(e, false)) : [h('div', { class: 'empty' }, 'No classes scheduled yet. Create one and share the link.')]));
    pastEl.replaceChildren(...past.map((e) => item(e, true)));
    pastWrap.classList.toggle('hidden', !past.length);
  } catch (x) {
    if (x.status === 401) showLogin('Please sign in again.');
  }
}

async function startNow() {
  const btn = $('#start-now');
  btn.disabled = true;
  try {
    const { event } = await api('event-save', { password, title: CFG.CLASS_TITLE || 'Live class', startsAt: new Date().toISOString(), durationMin: 60 });
    location.href = studioUrl(event);
  } catch (x) {
    btn.disabled = false;
    if (x.status === 401) showLogin('Please sign in again.'); else toast(x.message);
  }
}

function showDashboard() {
  signout.classList.remove('hidden');
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  main.replaceChildren(h('div', { class: 'dash' },
    h('div', { class: 'hello reveal' },
      h('div', {}, h('div', { class: 'eyebrow' }, 'Presenter'), h('h1', { class: 'display', style: 'margin-top:8px' }, `${greet}, `, h('span', { class: 'grad-text' }, (CFG.PRESENTER_NAME || 'Presenter').split(' ').slice(-1)[0]))),
      h('button', { class: 'btn primary lg', id: 'start-now', onclick: startNow, html: `${icon('bolt', 18)}Start a class now` })),
    h('div', { class: 'cols' },
      scheduleCard(),
      h('section', { class: 'card glass stack reveal d2' },
        h('div', { class: 'sec-title', html: `${icon('calendar', 20)}Your classes` }),
        listEl, pastWrap))));
  loadList();
  setInterval(loadList, 30000);
}

if (!password) showLogin(new URLSearchParams(location.search).get('e') ? 'Your session expired — please sign in again.' : '');
else showDashboard();

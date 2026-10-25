// ─── Home page: the next scheduled class with a live countdown ─────
import { api } from './live/api.js?v=36ab7949';
import { $, h, icon, orbit, fmtDate, fmtTime, fmtZone, classUrl } from './site.js?v=36ab7949';

for (const el of document.querySelectorAll('[data-i]')) el.innerHTML = icon(el.dataset.i, 22);

const box = $('#next');
const clock = orbit();
let ev = null;

async function load() {
  try {
    const res = await api('event-next');
    ev = res.event;
    render(res.live);
  } catch {
    $('#next-title').textContent = 'Couldn’t load the schedule';
  }
  setTimeout(load, 30000);
}

function render(live) {
  if (!ev) {
    box.replaceChildren(h('div', { class: 'eyebrow' }, 'Next class'), h('h2', {}, 'No class scheduled right now'), h('p', { class: 'when' }, 'Check back soon — the next session will appear here.'));
    return;
  }
  const url = classUrl(ev.id);
  const started = Date.now() >= Date.parse(ev.startsAt);
  box.replaceChildren(...[
    h('div', { class: 'row', style: 'justify-content:center' }, live
      ? h('span', { class: 'chip live', html: '<span class="pulse"></span>Live now' })
      : h('span', { class: 'chip soon' }, started ? 'Starting soon' : 'Next class')),
    h('h2', {}, ev.title),
    h('p', { class: 'when' }, `${fmtDate(ev.startsAt)} · ${fmtTime(ev.startsAt)} ${fmtZone()}`),
    live ? null : clock.el,
    h('a', { class: 'btn primary lg block', href: url, html: `${live ? 'Join the class' : 'Get the class link'}${icon('arrow', 18)}` }),
  ].filter(Boolean));
  tick();
}

function tick() {
  if (!ev) return;
  const left = Date.parse(ev.startsAt) - Date.now();
  clock.set(left, left > 0 ? 'Starts in' : 'Any moment');
}
setInterval(tick, 1000);
load();

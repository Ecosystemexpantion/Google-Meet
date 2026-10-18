// ─── Shared helpers for the site pages (home, class page, dashboard) ──
import { icon } from './live/icons.js?v=a032eb9d';

export { icon };
export const CFG = window.EEM26_CONFIG || {};
export const $ = (sel, root = document) => root.querySelector(sel);

/** Small DOM builder: h('div', { class: 'x', onclick }, child, …) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

export function toast(text) {
  let t = $('.toast');
  if (!t) { t = h('div', { class: 'toast glass', role: 'status' }); document.body.append(t); }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ── Time ──────────────────────────────────────────────────
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function fmtDate(iso, opts = {}) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...opts });
}
export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
export function fmtZone() {
  const name = new Date().toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop();
  return name || tz;
}
export function fmtWhen(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400e3);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const day = same(d, today) ? 'Today' : same(d, tomorrow) ? 'Tomorrow' : fmtDate(iso, { weekday: 'short', month: 'short' });
  return `${day} · ${fmtTime(iso)}`;
}

/** Parts of a duration in ms. */
export function parts(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}
const pad = (n) => String(n).padStart(2, '0');

// ── Countdown orbit ───────────────────────────────────────
// A glowing ring that fills as the class approaches (full over the last 24 h),
// with a "comet" riding the ring; the core shows the biggest unit, and a
// days/hours/minutes/seconds clock sits below.
export function orbit() {
  const R = 46;
  const C = 2 * Math.PI * R;
  const wrap = h('div', { class: 'orbit' });
  wrap.innerHTML = `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs><linearGradient id="orbit-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b6cff"/><stop offset=".55" stop-color="#5b8cff"/><stop offset="1" stop-color="#3fd8f5"/></linearGradient></defs>
      <circle class="ticks" cx="50" cy="50" r="49"/>
      <circle class="track" cx="50" cy="50" r="${R}"/>
      <circle class="ring" cx="50" cy="50" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/>
      <circle class="comet" cx="${50 + R}" cy="50" r="1.8"/>
    </svg>
    <div class="orbit-core"><div><div class="orbit-label">Starts in</div><div class="orbit-big">--</div><div class="orbit-unit"></div></div></div>`;
  const ring = wrap.querySelector('.ring');
  const comet = wrap.querySelector('.comet');
  const big = wrap.querySelector('.orbit-big');
  const unit = wrap.querySelector('.orbit-unit');
  const label = wrap.querySelector('.orbit-label');
  const clock = h('div', { class: 'clock' }, ...['Days', 'Hours', 'Min', 'Sec'].map((l) => h('div', { class: 'glass soft' }, h('b', {}, '00'), h('span', {}, l))));
  const cells = [...clock.querySelectorAll('b')];
  return {
    el: h('div', { class: 'stack', style: 'gap:22px' }, wrap, clock),
    set(msLeft, labelText = 'Starts in') {
      const p = parts(msLeft);
      const frac = Math.min(1, Math.max(0, 1 - msLeft / 86400e3));
      ring.style.strokeDashoffset = String(C * (1 - frac));
      const a = frac * 2 * Math.PI;
      comet.setAttribute('cx', String(50 + R * Math.cos(a)));
      comet.setAttribute('cy', String(50 + R * Math.sin(a)));
      label.textContent = labelText;
      if (p.d > 0) { big.textContent = p.d; unit.textContent = p.d === 1 ? 'day' : 'days'; }
      else if (p.h > 0) { big.textContent = `${p.h}:${pad(p.m)}`; unit.textContent = 'hours'; }
      else { big.textContent = `${p.m}:${pad(p.s)}`; unit.textContent = 'minutes'; }
      [p.d, p.h, p.m, p.s].forEach((v, i) => { cells[i].textContent = pad(v); });
    },
  };
}

// ── Calendar & sharing ────────────────────────────────────
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export function googleCalendar(ev, url) {
  const end = Date.parse(ev.startsAt) + ev.durationMin * 60e3;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates: `${stamp(ev.startsAt)}/${stamp(end)}`, details: `${ev.description ? `${ev.description}\n\n` : ''}Join: ${url}`, location: url });
  return `https://calendar.google.com/calendar/render?${q}`;
}
export function downloadIcs(ev, url) {
  const end = Date.parse(ev.startsAt) + ev.durationMin * 60e3;
  const esc = (s) => String(s).replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EEM26//Live Class//EN', 'BEGIN:VEVENT',
    `UID:${ev.id}@eem26`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(ev.startsAt)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(ev.title)}`, `DESCRIPTION:${esc(`${ev.description ? `${ev.description}\n\n` : ''}Join: ${url}`)}`, `URL:${url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.title)} starts in 15 minutes`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: `${ev.title.replace(/[^\w ]+/g, '').trim() || 'class'}.ics` });
  document.body.append(a); a.click(); a.remove();
}
export function classUrl(id) {
  return new URL(`class.html?e=${encodeURIComponent(id)}`, location.href).href;
}
export async function copy(text, done = 'Link copied') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(done);
}
export function shareText(ev, url) {
  return `${ev.title}\n${fmtDate(ev.startsAt)} · ${fmtTime(ev.startsAt)} (${fmtZone()})\nJoin here: ${url}`;
}
export async function share(ev, url) {
  if (navigator.share) {
    try { await navigator.share({ title: ev.title, text: shareText(ev, url).replace(`\nJoin here: ${url}`, ''), url }); return; } catch { /* cancelled */ }
  }
  copy(shareText(ev, url), 'Invitation copied');
}
export function whatsapp(ev, url) {
  return `https://wa.me/?text=${encodeURIComponent(shareText(ev, url))}`;
}

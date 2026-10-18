// ─── EEM26 Live Classroom ──────────────────────────────────
// One presenter, up to a few hundred viewers, on Cloudflare Realtime SFU.
// The same module powers the attendee room (room.html) and the presenter
// studio (host-room.html); <body data-role> picks the mode.
//
// The presenter's browser is the authority for the class: it receives every
// attendee's messages on their private "up" channel, applies the rules
// (chat mode, mutes, who may share) and broadcasts the result to everyone on
// its "room" channel. Attendees only ever see what the presenter relays.
import { icon } from './icons.js';
import { api, ApiError, supabaseClient } from './api.js';
import { Media, DataLink, iceServers, setAuthToken, whenOpen } from './rtc.js';

const CFG = window.EEM26_CONFIG || {};
const IS_HOST = document.body.dataset.role === 'host';
const HOST_ID = 'host';
const REACTIONS = ['👏', '❤️', '😂', '🎉', '👍', '😮', '🔥', '🙏'];
const CHAT_EMOJI = ['😀', '😂', '😍', '🙌', '👏', '👍', '🙏', '🔥', '🎉', '💯', '❤️', '😮', '🤔', '😅', '✅', '❓', '💡', '🚀', '👀', '😎', '🥳', '💪', '🤝', '✍️'];
const MAX_CHAT = 500;
const DEFAULT_SETTINGS = { chat: 'everyone', reactions: true, hands: true, locked: false, showPeople: false, banner: '', title: '' };
const ONLINE_MS = 35000;
const SOURCES = ['screen', 'mic', 'camera'];

const $ = (sel, root = document) => root.querySelector(sel);

// ── State ──────────────────────────────────────────────────
const S = {
  token: null,
  identity: IS_HOST ? HOST_ID : null,
  name: '',
  room: '',
  live: false,
  media: null,
  data: null,
  roomCh: null,             // presenter: local "room" channel; attendee: remote subscription
  upCh: null,               // attendee: local "up" channel
  hostDataSession: null,
  settings: { ...DEFAULT_SETTINGS },
  startedAt: null,
  view: null,               // last class snapshot (see hostSnapshot())
  lastStateAt: 0,
  synced: false,
  // presenter-only registry of attendees
  people: new Map(),
  attCursor: 0,
  // local media: kind → { track, handle, meta, on }
  local: {},
  shareMotion: false,
  pulls: new Map(),         // key → { handle, track, kind, owner }
  videoEls: new Map(),      // track id → <video>
  messages: [],
  unread: 0,
  panel: window.innerWidth > 900 ? 'chat' : null,
  peopleFilter: '',
  poll: null,
  polls: [],
  votes: new Map(),
  results: new Map(),
  myVotes: new Map(),
  pendingReactions: [],
  lastReactionAt: 0,
  timers: [],
  ended: false,
};

// ── DOM helpers ────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function hue(str) {
  let x = 0;
  for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

function avatar(name, id, cls = '') {
  return h('div', { class: `lv-avatar ${cls}`, style: `--h:${hue(id || name)}` }, initials(name));
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function uid() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9-]/gi, '');
}

const pending = new Map();
function schedule(key, fn, delay = 0) {
  if (pending.has(key)) return;
  pending.set(key, true);
  const run = () => { pending.delete(key); fn(); };
  delay ? setTimeout(run, delay) : requestAnimationFrame(run);
}

function every(ms, fn) {
  S.timers.push(setInterval(fn, ms));
}

// ── Toasts / modal ─────────────────────────────────────────
function toast(text, kind = 'info', ms = 4200) {
  const el = h('div', { class: `lv-toast ${kind}`, role: 'status' }, text);
  const box = $('#lv-toasts');
  box.append(el);
  while (box.childElementCount > 3) box.firstChild.remove();
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

function modal({ title, body, actions }) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'lv-modal-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'lv-modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'lv-modal-head' }, h('h3', {}, title),
        h('button', { class: 'lv-icon-btn', 'aria-label': 'Close', html: icon('x'), onclick: close })),
      h('div', { class: 'lv-modal-body' }, body),
      actions ? h('div', { class: 'lv-modal-actions' }, actions.map((a) =>
        h('button', { class: `lv-btn ${a.kind || ''}`, onclick: async () => { if ((await a.run?.()) !== false) close(); } }, a.label))) : null));
  document.body.append(wrap);
  return close;
}

function beep() {
  try {
    const ctx = beep.ctx || (beep.ctx = new AudioContext());
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25);
  } catch { /* audio unavailable */ }
}

// ── Messaging ──────────────────────────────────────────────
function sendRoom(msg) {
  if (S.roomCh?.readyState === 'open') {
    try { S.roomCh.send(JSON.stringify(msg)); } catch (e) { console.warn('room send', e); }
  }
}

function sendUp(msg) {
  if (S.upCh?.readyState === 'open') {
    try { S.upCh.send(JSON.stringify(msg)); return true; } catch (e) { console.warn('up send', e); }
  }
  return false;
}

function parse(ev) {
  try { return JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
  catch { return null; }
}

// ── View model ─────────────────────────────────────────────
// Both roles render from the same snapshot shape. The presenter builds it
// from its own registry; attendees receive it on the "room" channel.
function onlinePeople() {
  const now = Date.now();
  return [...S.people.values()].filter((p) => now - p.lastSeen < ONLINE_MS && !p.left);
}

function hostSnapshot() {
  const l = S.local;
  const online = onlinePeople();
  const stage = online.filter((p) => p.grants.size).map((p) => ({
    id: p.identity,
    name: p.name,
    sources: [...p.grants],
    micOn: p.grants.has('mic') && !!p.micOn,
    camOn: p.grants.has('camera') && !!p.camOn,
    sharing: p.grants.has('screen') && !!p.sharing,
    shareAt: p.shareAt || 0,
    tracks: filterTracks(p.tracks, p.grants),
  }));
  return {
    t: 'state',
    settings: S.settings,
    startedAt: S.startedAt,
    count: online.length + 1,
    host: {
      name: S.name,
      micOn: !!l.mic?.on,
      camOn: !!l.camera?.meta,
      sharing: !!l.screen?.meta,
      shareAt: l.screen?.at || 0,
      tracks: {
        mic: l.mic?.meta || null,
        camera: l.camera?.meta || null,
        screen: l.screen?.meta || null,
        screenAudio: l.screenAudio?.meta || null,
      },
    },
    stage,
    hands: online.filter((p) => p.hand).sort((a, b) => a.hand - b.hand).map((p) => p.identity),
    blocked: online.filter((p) => p.blocked).map((p) => p.identity),
    roster: S.settings.showPeople ? online.slice(0, 300).map((p) => [p.identity, p.name.slice(0, 24)]) : null,
    poll: S.poll,
  };
}

function filterTracks(tracks = {}, grants) {
  return {
    mic: grants.has('mic') ? tracks.mic || null : null,
    camera: grants.has('camera') ? tracks.camera || null : null,
    screen: grants.has('screen') ? tracks.screen || null : null,
    screenAudio: grants.has('screen') ? tracks.screenAudio || null : null,
  };
}

function myStage() {
  if (IS_HOST) return { sources: SOURCES };
  return S.view?.stage?.find((s) => s.id === S.identity) || null;
}
function can(source) {
  return IS_HOST || !!myStage()?.sources.includes(source);
}
function chatBlocked() {
  return !IS_HOST && !!S.view?.blocked?.includes(S.identity);
}
function myHandUp() {
  return !IS_HOST && !!S.view?.hands?.includes(S.identity);
}

// ── Shell ──────────────────────────────────────────────────
function shell() {
  const brand = CFG.BRAND_SHORT || 'EEM26';
  const app = h('div', { class: 'lv-app', id: 'lv-app', 'data-state': 'prejoin' },
    h('header', { class: 'lv-top' },
      h('div', { class: 'lv-brand' }, h('span', { class: 'lv-chip' }, brand),
        h('div', { class: 'lv-title-wrap' },
          h('div', { class: 'lv-title', id: 'lv-title' }, CFG.CLASS_TITLE || 'Live Class'),
          h('div', { class: 'lv-sub', id: 'lv-sub' }, CFG.PRESENTER_NAME ? `with ${CFG.PRESENTER_NAME}` : ''))),
      h('div', { class: 'lv-top-mid' },
        h('span', { class: 'lv-live', id: 'lv-live' }, h('span', { class: 'lv-dot' }), 'LIVE', h('span', { id: 'lv-timer', class: 'lv-timer' }, '00:00'))),
      h('div', { class: 'lv-top-right' },
        h('span', { class: 'lv-pill hidden', id: 'lv-locked', title: 'Room is locked', html: `${icon('lock', 14)} Locked` }),
        IS_HOST ? h('button', { class: 'lv-pill lv-pill-btn', id: 'lv-hands-pill', title: 'Raised hands', onclick: () => openPanel('people'), html: `${icon('hand', 14)} <b id="lv-hands-count">0</b>` }) : null,
        h('span', { class: 'lv-pill', title: 'People in the class', html: `${icon('eye', 14)} <b id="lv-count">0</b>` }),
        h('span', { class: 'lv-quality', id: 'lv-quality', title: 'Connection', html: icon('signal', 16) }))),

    h('div', { class: 'lv-body' },
      h('main', { class: 'lv-stage-wrap' },
        h('div', { class: 'lv-banner hidden', id: 'lv-banner' }),
        h('div', { class: 'lv-stage', id: 'lv-stage' },
          h('div', { class: 'lv-main', id: 'lv-main' }),
          h('div', { class: 'lv-pip hidden', id: 'lv-pip' }),
          h('div', { class: 'lv-stage-label hidden', id: 'lv-stage-label' }),
          h('div', { class: 'lv-reactions', id: 'lv-reactions', 'aria-hidden': 'true' }),
          h('button', { class: 'lv-icon-btn lv-fs', title: 'Full screen', 'aria-label': 'Full screen', html: icon('maximize'), onclick: toggleFullscreen })),
        h('div', { class: 'lv-strip hidden', id: 'lv-strip' })),
      h('aside', { class: 'lv-side', id: 'lv-side', 'aria-label': 'Side panel' },
        h('div', { class: 'lv-tabs', role: 'tablist' },
          tabBtn('chat', 'Chat'), tabBtn('people', 'People'), tabBtn('polls', 'Polls'),
          IS_HOST ? tabBtn('room', 'Controls') : null,
          h('button', { class: 'lv-icon-btn lv-side-close', 'aria-label': 'Close panel', html: icon('x'), onclick: () => openPanel(null) })),
        h('section', { class: 'lv-panel', id: 'panel-chat' }),
        h('section', { class: 'lv-panel', id: 'panel-people' }),
        h('section', { class: 'lv-panel', id: 'panel-polls' }),
        IS_HOST ? h('section', { class: 'lv-panel', id: 'panel-room' }) : null)),

    h('footer', { class: 'lv-controls', id: 'lv-controls' }),
    h('div', { class: 'lv-overlay', id: 'lv-overlay' }),
    h('button', { class: 'lv-audio-unlock hidden', id: 'lv-audio-unlock', onclick: unlockAudio, html: `${icon('volume')} Tap to enable sound` }),
    h('div', { class: 'lv-toasts', id: 'lv-toasts', 'aria-live': 'polite' }),
    h('div', { id: 'lv-audio-sink', class: 'hidden' }));
  document.body.append(app);
  buildChatPanel();
  buildPeoplePanel();
  if (IS_HOST) buildRoomPanel();
  renderPolls();
}

function tabBtn(id, label) {
  return h('button', { class: 'lv-tab', role: 'tab', 'data-tab': id, onclick: () => openPanel(id) },
    label, h('span', { class: 'lv-badge hidden', id: `badge-${id}` }));
}

function openPanel(id) {
  S.panel = S.panel === id && window.innerWidth <= 900 ? null : id;
  if (id === null) S.panel = null;
  $('#lv-app').classList.toggle('side-open', !!S.panel);
  document.querySelectorAll('.lv-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.panel));
  document.querySelectorAll('.lv-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${S.panel}`));
  if (S.panel === 'chat') { S.unread = 0; updateBadges(); setTimeout(scrollChat, 0); }
  if (S.panel === 'people') renderPeople();
  renderControls();
}

function toggleFullscreen() {
  const stage = $('#lv-stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
}

function unlockAudio() {
  document.querySelectorAll('#lv-audio-sink audio').forEach((a) => a.play().catch(() => {}));
  $('#lv-audio-unlock').classList.add('hidden');
}

// ── Pre-join ───────────────────────────────────────────────
function params() {
  const q = new URLSearchParams(location.search);
  let stored = {};
  try { stored = JSON.parse(sessionStorage.getItem('eem26_p') || '{}'); } catch { /* ignore */ }
  return {
    name: q.get('n') || stored.fullName || stored.name || localStorage.getItem('eem26_name') || '',
    pid: q.get('pid') || stored.id || localStorage.getItem('eem26_pid') || uid(),
    room: q.get('rm') || q.get('room') || stored.roomName || '',
  };
}

function weekRoomName() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - y) / 86400000) + 1) / 7);
  return `${CFG.ROOM_PREFIX || 'Class'}${now.getFullYear()}W${String(week).padStart(2, '0')}`;
}

async function latestRoomFromSupabase() {
  const sb = supabaseClient();
  if (!sb) return '';
  try {
    const { data } = await sb.from('sessions').select('room_name,is_active').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data?.is_active ? data.room_name : '';
  } catch { return ''; }
}

async function markSupabaseSession(roomName, active) {
  const sb = supabaseClient();
  if (!sb) return;
  try {
    const { data } = await sb.from('sessions').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const row = active
      ? { room_name: roomName, is_active: true, started_at: new Date().toISOString(), ended_at: null }
      : { is_active: false, ended_at: new Date().toISOString() };
    if (data) await sb.from('sessions').update(row).eq('id', data.id);
    else if (active) await sb.from('sessions').insert(row);
  } catch (err) { console.warn('supabase session flag', err); }
}

function showPrejoin() {
  const ov = $('#lv-overlay');
  ov.replaceChildren();
  ov.classList.remove('hidden');
  const p = params();

  if (IS_HOST) {
    const password = sessionStorage.getItem('eem26_host_pw');
    if (!password) { location.href = 'host.html'; return; }
    const titleIn = h('input', { class: 'lv-input', id: 'pj-title', maxlength: 120, value: CFG.CLASS_TITLE || '', placeholder: 'Session title' });
    const micIn = h('input', { type: 'checkbox', id: 'pj-mic', checked: true });
    const camIn = h('input', { type: 'checkbox', id: 'pj-cam' });
    const err = h('div', { class: 'lv-error hidden', role: 'alert' });
    const btn = h('button', { class: 'lv-btn primary lg', id: 'pj-start' }, 'Start the class');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Opening room…'; err.classList.add('hidden');
      const room = new URLSearchParams(location.search).get('room') || weekRoomName();
      try {
        S.name = CFG.PRESENTER_NAME || 'Presenter';
        const res = await api('host-open', { password, room, title: titleIn.value, name: S.name });
        await startHost(res, room, { mic: micIn.checked, cam: camIn.checked });
        markSupabaseSession(room, true);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          sessionStorage.removeItem('eem26_host_pw');
          location.href = 'host.html?e=1';
          return;
        }
        console.error(e);
        err.textContent = e.message; err.classList.remove('hidden');
        btn.disabled = false; btn.textContent = 'Start the class';
      }
    };
    ov.append(h('div', { class: 'lv-card' },
      h('span', { class: 'lv-chip lg' }, CFG.BRAND_SHORT || 'EEM26'),
      h('h1', {}, 'Presenter studio'),
      h('p', { class: 'muted' }, 'Opening the room lets attendees in. You control screen sharing, chat, reactions and who can speak.'),
      h('label', { class: 'lv-label', for: 'pj-title' }, 'Session title'), titleIn,
      h('div', { class: 'lv-checks' },
        h('label', { class: 'lv-check' }, micIn, 'Join with microphone on'),
        h('label', { class: 'lv-check' }, camIn, 'Join with camera on')),
      err, btn,
      h('a', { class: 'lv-link', href: 'host.html', onclick: () => sessionStorage.removeItem('eem26_host_pw') }, 'Sign out')));
    return;
  }

  const nameIn = h('input', { class: 'lv-input', id: 'pj-name', maxlength: 40, value: p.name, placeholder: 'Your name', autocomplete: 'name' });
  const err = h('div', { class: 'lv-error hidden', role: 'alert' });
  const btn = h('button', { class: 'lv-btn primary lg', id: 'pj-join' }, 'Join class');
  let retry = null;
  const attempt = async () => {
    clearTimeout(retry);
    const name = nameIn.value.trim();
    if (name.length < 2) { err.textContent = 'Please enter your name (at least 2 letters).'; err.className = 'lv-error'; nameIn.focus(); return; }
    btn.disabled = true; btn.textContent = 'Joining…'; err.classList.add('hidden');
    localStorage.setItem('eem26_name', name);
    localStorage.setItem('eem26_pid', p.pid);
    const room = p.room || await latestRoomFromSupabase() || weekRoomName();
    try {
      const res = await api('join', { room, name, id: p.pid });
      S.name = name;
      await startGuest(res, room);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Join class';
      if (e instanceof ApiError && (e.code === 'not_started' || e.code === 'locked')) {
        err.textContent = e.code === 'not_started'
          ? 'The presenter hasn’t opened the room yet. We’ll let you in automatically as soon as it opens…'
          : 'The presenter has locked the room. Retrying in a moment…';
        err.className = 'lv-error info';
        btn.textContent = 'Waiting…'; btn.disabled = true;
        retry = setTimeout(attempt, 8000);
      } else {
        console.error(e);
        err.textContent = e.message; err.className = 'lv-error';
      }
    }
  };
  btn.onclick = attempt;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  ov.append(h('div', { class: 'lv-card' },
    h('span', { class: 'lv-chip lg' }, CFG.BRAND_SHORT || 'EEM26'),
    h('h1', {}, CFG.CLASS_TITLE || 'Live Class'),
    h('p', { class: 'muted' }, CFG.PRESENTER_NAME ? `Live with ${CFG.PRESENTER_NAME}. You’ll join as a viewer — raise your hand to speak.` : 'You’ll join as a viewer — raise your hand to speak.'),
    h('label', { class: 'lv-label', for: 'pj-name' }, 'Your name'), nameIn,
    err, btn,
    h('p', { class: 'lv-fine' }, 'Works in any modern browser on phone or computer. No download needed.')));
  if (p.name.length >= 2 && p.room) setTimeout(() => btn.focus(), 50);
}

function goLive() {
  S.live = true;
  $('#lv-overlay').classList.add('hidden');
  $('#lv-app').dataset.state = 'live';
  applySettings();
  openPanel(S.panel);
  renderAll();
  every(1000, tickTimer);
  window.__lv = S; // handy for debugging from the console
}

// ── Presenter start ────────────────────────────────────────
async function startHost(res, room, opts = {}) {
  S.token = res.token;
  S.room = room;
  setAuthToken(res.token);
  restoreHostState();
  S.settings = { ...S.settings, title: res.room.title || S.settings.title, locked: res.room.locked };
  S.startedAt = res.room.startedAt || Date.now();

  S.media = new Media();
  S.data = new DataLink();
  S.data.addEventListener('state', (e) => onLinkState(e.detail));
  const sessionId = await S.data.open(await iceServers());
  const [roomCh] = await S.data.add([{ location: 'local', dataChannelName: 'room' }]);
  if (!roomCh) throw new Error('Could not open the class channel.');
  S.roomCh = roomCh;
  await api('host-ready', { token: S.token, dataSession: sessionId });

  goLive();
  if (opts.mic) toggleMic();
  if (opts.cam) toggleCam();
  toast('You’re live. Attendees can join now.', 'success');

  pollAttendees();
  every(2500, pollAttendees);
  every(3000, () => broadcastState(true));
  every(600, flushReactions);
  every(5000, () => { schedule('people', renderPeople, 250); updateCount(); });
}

let lastStateJson = '';
function broadcastState(force) {
  if (!IS_HOST || !S.live) return;
  const snap = hostSnapshot();
  const json = JSON.stringify(snap);
  S.view = snap;
  if (force || json !== lastStateJson) sendRoom(snap);
  lastStateJson = json;
}
function stateChanged() {
  schedule('state', () => { broadcastState(false); renderAll(); }, 120);
  saveHostState();
}

async function pollAttendees() {
  if (S.polling) return;
  S.polling = true;
  try {
    const { attendees } = await api('host-poll', { token: S.token, after: S.attCursor });
    if (!attendees.length) return;
    // newest registration per person wins (a rejoin replaces the old one)
    const latest = new Map(attendees.map((a) => [a.identity, a]));
    const fresh = [...latest.values()].filter((a) => S.people.get(a.identity)?.dataSession !== a.data_session);
    for (let i = 0; i < fresh.length; i += 50) {
      const batch = fresh.slice(i, i + 50);
      const chans = await S.data.add(batch.map((a) => ({ location: 'remote', dataChannelName: 'up', sessionId: a.data_session })));
      batch.forEach((a, k) => attachAttendee(a, chans[k]));
    }
    // only move on once everyone in this page is subscribed; a failure retries next poll
    S.attCursor = attendees[attendees.length - 1].id;
  } catch (err) {
    console.warn('poll attendees', err);
  } finally {
    S.polling = false;
  }
}

function attachAttendee(a, ch) {
  let p = S.people.get(a.identity);
  if (p?.ch && p.ch !== ch) { S.data.close([p.ch.sfuId]); try { p.ch.close(); } catch { /* closed */ } }
  if (!p) {
    const saved = S.restoredPeople?.get(a.identity); // grants/blocks survive a presenter refresh
    p = { identity: a.identity, name: a.name, grants: new Set(saved?.grants || []), tracks: {}, hand: 0, blocked: !!saved?.blocked, lastSeen: 0, chatAt: [] };
    S.people.set(a.identity, p);
  }
  p.dataSession = a.data_session;
  p.ch = ch;
  p.left = false;
  if (!ch) return;
  ch.addEventListener('message', (ev) => {
    const msg = parse(ev);
    if (msg && S.people.get(a.identity)?.ch === ch) onUp(p, msg);
  });
}

// ── Attendee start ─────────────────────────────────────────
async function startGuest(res, room) {
  S.token = res.token;
  S.identity = res.identity;
  S.room = room;
  setAuthToken(res.token);
  S.hostDataSession = res.room.hostDataSession;
  S.settings = { ...S.settings, title: res.room.title };
  S.startedAt = res.room.startedAt;

  S.media = new Media();
  S.data = new DataLink();
  S.data.addEventListener('state', (e) => onLinkState(e.detail));
  const sessionId = await S.data.open(await iceServers());
  const [up, roomCh] = await S.data.add([
    { location: 'local', dataChannelName: 'up' },
    { location: 'remote', dataChannelName: 'room', sessionId: S.hostDataSession },
  ]);
  if (!up || !roomCh) throw new Error('Could not connect to the class. Please try again.');
  S.upCh = up;
  bindRoomChannel(roomCh);
  await api('register', { token: S.token, dataSession: sessionId });
  goLive();
  hello();
  every(10000, () => sendUp({ t: 'ping' }));
  every(5000, watchHost);
  window.addEventListener('pagehide', () => sendUp({ t: 'bye' }));
}

function bindRoomChannel(ch) {
  S.roomCh = ch;
  ch.addEventListener('message', (ev) => {
    if (S.roomCh !== ch) return;
    const msg = parse(ev);
    if (msg) onRoom(msg);
  });
}

// Keep saying hello until the presenter confirms it can hear us.
function hello() {
  S.synced = false;
  let tries = 0;
  const ping = () => {
    if (S.synced || S.ended || tries++ > 20) return;
    sendUp({ t: 'hello', hand: false });
    reportMedia();
    setTimeout(ping, 3000);
  };
  ping();
}

// If the presenter goes quiet, check whether they reconnected or ended.
async function watchHost() {
  if (S.ended || Date.now() - S.lastStateAt < 12000) return;
  if (S.lastStateAt) showReconnect(true, 'The presenter’s connection dropped — waiting for them…');
  try {
    const { room } = await api('room-info', { room: S.room });
    if (!room?.open) { if (S.lastStateAt || !room) endClass('ended'); return; }
    if (room.hostDataSession && room.hostDataSession !== S.hostDataSession) {
      S.hostDataSession = room.hostDataSession;
      const old = S.roomCh;
      const [ch] = await S.data.add([{ location: 'remote', dataChannelName: 'room', sessionId: room.hostDataSession }]);
      if (ch) {
        bindRoomChannel(ch);
        if (old) { S.data.close([old.sfuId]); try { old.close(); } catch { /* closed */ } }
        hello();
      }
    }
  } catch (err) { console.warn('watch host', err); }
}

function onLinkState(state) {
  $('#lv-quality').dataset.q = state === 'connected' ? 'excellent' : state === 'failed' || state === 'disconnected' ? 'lost' : 'poor';
  if (state === 'failed') {
    showReconnect(true, 'Connection lost — rejoining…');
    if (!S.ended) setTimeout(() => location.reload(), 2500);
  }
}

function showReconnect(on, text = 'Reconnecting…') {
  let el = $('#lv-reconnect');
  if (on && !el) $('#lv-app').append(el = h('div', { class: 'lv-reconnect', id: 'lv-reconnect' }, h('span', { class: 'lv-spin' }), h('span', {}, text)));
  else if (on) el.lastChild.textContent = text;
  if (!on && el) el.remove();
}

// ── Incoming: presenter → attendees ────────────────────────
function onRoom(msg) {
  switch (msg.t) {
    case 'state': {
      const before = S.settings;
      S.view = msg;
      S.lastStateAt = Date.now();
      showReconnect(false);
      S.settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      S.startedAt = msg.startedAt;
      S.poll = msg.poll || S.poll;
      applySettings(before);
      reconcilePulls();
      onMyStage();
      renderAll();
      break;
    }
    case 'chat':
      addMessage(msg.m);
      break;
    case 'history':
      if ((msg.for || []).includes(S.identity)) S.synced = true;
      for (const m of msg.msgs || []) addMessage({ ...m, quiet: true }, true);
      renderChat();
      if (msg.poll) S.poll = msg.poll;
      if (msg.results) S.results.set(msg.results.id, msg.results);
      renderPolls(); renderControls();
      break;
    case 'chat-del':
      removeMessage(msg.id);
      break;
    case 'react':
      (msg.list || []).slice(0, 30).forEach(([e, who]) => REACTIONS.includes(e) && showReaction(e, who));
      break;
    case 'poll':
      if (!msg.poll) return;
      if (!S.poll || S.poll.id !== msg.poll.id) toast('📊 New poll from the presenter', 'info');
      S.poll = msg.poll;
      renderPolls(); renderControls();
      if (S.poll.open && !S.myVotes.has(S.poll.id) && window.innerWidth > 900) openPanel('polls');
      break;
    case 'results':
      S.results.set(msg.id, { id: msg.id, counts: msg.counts, total: msg.total });
      renderPolls();
      break;
    case 'lower-hand':
      if (msg.who === '*' || msg.who === S.identity) toast('The presenter lowered your hand.', 'info');
      break;
    case 'mute':
      if (msg.id === S.identity && S.local.mic?.on) { setMic(false); toast('The presenter muted your microphone.', 'info'); }
      break;
    case 'stop-share':
      if (msg.id === S.identity && S.local.screen) { stopScreen(); toast('The presenter stopped your screen share.', 'info'); }
      break;
    case 'kick':
      if (msg.id === S.identity) endClass('removed');
      break;
    case 'end':
      endClass('ended');
      break;
    default:
  }
}

// ── Incoming: attendee → presenter ─────────────────────────
function onUp(p, msg) {
  const was = p.lastSeen && Date.now() - p.lastSeen < ONLINE_MS;
  p.lastSeen = Date.now();
  p.left = false;
  if (!was) { stateChanged(); schedule('people', renderPeople, 250); }
  switch (msg.t) {
    case 'hello':
      queueHistoryFor(p.identity);
      break;
    case 'ping':
      break;
    case 'bye':
      p.left = true;
      stateChanged();
      break;
    case 'chat': {
      if (typeof msg.text !== 'string' || p.blocked || S.settings.chat === 'off') return;
      const at = Date.now();
      p.chatAt = p.chatAt.filter((t) => at - t < 5000);
      if (p.chatAt.length >= 4) return; // max 4 messages / 5 s per person
      p.chatAt.push(at);
      const priv = S.settings.chat === 'to-host' || !!msg.priv;
      const m = { id: String(msg.id || uid()).slice(0, 40), from: p.identity, name: p.name, text: msg.text.slice(0, 500), ts: at, priv, host: false };
      addMessage(m);
      if (!priv) sendRoom({ t: 'chat', m });
      saveHostState();
      break;
    }
    case 'react':
      if (S.settings.reactions && REACTIONS.includes(msg.e) && Date.now() - (p.reactAt || 0) > 300) {
        p.reactAt = Date.now();
        S.pendingReactions.push([msg.e, null]);
        showReaction(msg.e);
      }
      break;
    case 'hand': {
      const up = S.settings.hands && !!msg.up;
      if (!!p.hand === up) return;
      p.hand = up ? Date.now() : 0;
      if (up) { toast(`✋ ${p.name} raised their hand`, 'info', 3500); beep(); }
      stateChanged();
      break;
    }
    case 'vote':
      onVote(p, msg);
      break;
    case 'media': {
      // An attendee on stage reports what they're publishing. Only granted
      // sources ever make it into the snapshot.
      const t = msg.tracks || {};
      const valid = (m) => (m && typeof m.sessionId === 'string' && typeof m.trackName === 'string' ? { sessionId: m.sessionId, trackName: m.trackName, location: 'remote' } : null);
      const wasSharing = p.sharing;
      p.tracks = { mic: valid(t.mic), camera: valid(t.camera), screen: valid(t.screen), screenAudio: valid(t.screenAudio) };
      p.micOn = !!msg.micOn;
      p.camOn = !!msg.camOn && !!p.tracks.camera;
      p.sharing = !!p.tracks.screen;
      if (p.sharing && !wasSharing) p.shareAt = Date.now();
      stateChanged();
      reconcilePulls();
      break;
    }
    default:
  }
}

const historyFor = new Set();
function queueHistoryFor(id) {
  historyFor.add(id);
  schedule('history', () => {
    const ids = [...historyFor];
    historyFor.clear();
    const pub = S.messages.filter((m) => !m.priv).slice(-40).map(({ id: mid, from, name, text, ts, host }) => ({ id: mid, from, name, text, ts, host }));
    const results = S.poll && (S.poll.showResults || !S.poll.open) ? S.results.get(S.poll.id) : null;
    // keep each packet comfortably small
    for (let i = 0; i < Math.max(1, pub.length); i += 12) {
      sendRoom({ t: 'history', for: i === 0 ? ids : [], msgs: pub.slice(i, i + 12), poll: i === 0 ? S.poll : undefined, results: i === 0 ? results : undefined });
    }
    broadcastState(true);
  }, 700);
}

function flushReactions() {
  if (!S.pendingReactions.length) return;
  sendRoom({ t: 'react', list: S.pendingReactions.splice(0, 24) });
  S.pendingReactions.length = 0; // drop the overflow of a reaction storm
}

// ── Pulling remote media ───────────────────────────────────
function wantedTracks() {
  const v = S.view;
  const out = [];
  if (!v) return out;
  const add = (owner, name, kind, meta) => { if (meta?.sessionId) out.push({ key: `${meta.sessionId}/${meta.trackName}`, owner, name, kind, meta }); };
  if (!IS_HOST) {
    add(HOST_ID, v.host.name, 'mic', v.host.tracks.mic);
    if (v.host.camOn) add(HOST_ID, v.host.name, 'camera', v.host.tracks.camera);
    if (v.host.sharing) { add(HOST_ID, v.host.name, 'screen', v.host.tracks.screen); add(HOST_ID, v.host.name, 'screenAudio', v.host.tracks.screenAudio); }
  }
  for (const s of v.stage || []) {
    if (s.id === S.identity) continue;
    if (s.tracks.mic) add(s.id, s.name, 'mic', s.tracks.mic);
    if (s.camOn) add(s.id, s.name, 'camera', s.tracks.camera);
    if (s.sharing) { add(s.id, s.name, 'screen', s.tracks.screen); add(s.id, s.name, 'screenAudio', s.tracks.screenAudio); }
  }
  return out;
}

function reconcilePulls() {
  if (IS_HOST) S.view = hostSnapshot();
  const wanted = wantedTracks();
  const keep = new Set(wanted.map((w) => w.key));
  for (const [key, pull] of S.pulls) {
    if (!keep.has(key)) {
      pull.handle.stop();
      pull.audio?.remove();
      S.pulls.delete(key);
    }
  }
  const small = window.innerWidth < 900;
  for (const w of wanted) {
    if (S.pulls.has(w.key)) continue;
    const entry = { kind: w.kind, owner: w.owner, track: null };
    entry.handle = S.media.pull(w.meta, {
      rid: w.kind === 'screen' ? (small ? 'h' : 'f') : undefined,
      onTrack: (track) => {
        entry.track = track;
        if (track.kind === 'audio') {
          entry.audio?.remove();
          const el = h('audio', { autoplay: true });
          el.srcObject = new MediaStream([track]);
          if (S.sinkId && el.setSinkId) el.setSinkId(S.sinkId).catch(() => {});
          $('#lv-audio-sink').append(el);
          el.play().catch(() => $('#lv-audio-unlock').classList.remove('hidden'));
          entry.audio = el;
        }
        schedule('stage', renderStage);
      },
    });
    S.pulls.set(w.key, entry);
  }
  schedule('stage', renderStage);
}

function pulled(owner, kind) {
  for (const p of S.pulls.values()) if (p.owner === owner && p.kind === kind && p.track) return p.track;
  return null;
}

// ── Local media ────────────────────────────────────────────
function pushLocal(kind, track, encodings) {
  const cur = S.local[kind] || {};
  cur.track = track;
  cur.handle = S.media.push(track, {
    encodings,
    onMeta: (meta) => { cur.meta = meta; afterLocalChange(); },
  });
  S.local[kind] = cur;
  return cur;
}

function stopLocal(kind) {
  const cur = S.local[kind];
  if (!cur) return;
  cur.handle?.stop();
  cur.track?.stop();
  delete S.local[kind];
  afterLocalChange();
}

function afterLocalChange() {
  if (IS_HOST) stateChanged();
  else reportMedia();
  renderControls();
  schedule('stage', renderStage);
}

function reportMedia() {
  if (IS_HOST) return;
  const l = S.local;
  sendUp({
    t: 'media',
    micOn: !!l.mic?.on,
    camOn: !!l.camera?.meta,
    tracks: { mic: l.mic?.meta || null, camera: l.camera?.meta || null, screen: l.screen?.meta || null, screenAudio: l.screenAudio?.meta || null },
  });
}

let mediaQueue = Promise.resolve();
function media(fn) {
  const run = mediaQueue.then(fn).catch(mediaError).finally(renderControls);
  mediaQueue = run;
  return run;
}

function toggleMic() {
  return media(async () => setMic(!S.local.mic?.on));
}

async function setMic(on) {
  if (on && !can('mic')) return;
  const cur = S.local.mic;
  if (on && !cur) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: S.micId ? { exact: S.micId } : undefined } });
    pushLocal('mic', stream.getAudioTracks()[0]).on = true;
  } else if (cur) {
    cur.on = on;
    cur.track.enabled = on; // stay published; muting just sends silence
  }
  afterLocalChange();
}

function toggleCam() {
  return media(async () => {
    if (S.local.camera) { stopLocal('camera'); return; }
    if (!can('camera')) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 }, deviceId: S.camId ? { exact: S.camId } : undefined } });
    pushLocal('camera', stream.getVideoTracks()[0], [{ maxBitrate: 600_000, maxFramerate: 24, scaleResolutionDownBy: 2 }]);
  });
}

function toggleScreen() {
  return media(async () => {
    if (S.local.screen) { stopScreen(); return; }
    if (!can('screen')) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('Screen sharing isn’t supported on this device. Use Chrome, Edge or Firefox on a computer.', 'error', 6000);
      return;
    }
    const motion = S.shareMotion;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: motion ? 30 : 15 } },
        audio: true,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return; // user cancelled
      throw err;
    }
    const video = stream.getVideoTracks()[0];
    video.contentHint = motion ? 'motion' : 'detail';
    video.addEventListener('ended', () => media(async () => stopScreen()));
    // Two layers: phones and weak connections pull the light one.
    const fps = motion ? 30 : 15;
    const s = pushLocal('screen', video, [
      { rid: 'f', maxBitrate: motion ? 2_500_000 : 1_500_000, maxFramerate: fps },
      { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: motion ? 700_000 : 400_000, maxFramerate: fps },
    ]);
    s.at = Date.now();
    const audio = stream.getAudioTracks()[0];
    if (audio) pushLocal('screenAudio', audio);
  });
}

function stopScreen() {
  stopLocal('screenAudio');
  stopLocal('screen');
}

function onMyStage() {
  if (IS_HOST) return;
  const st = myStage();
  const had = S.myGrants || new Set();
  const now2 = new Set(st?.sources || []);
  S.myGrants = now2;
  const gained = [...now2].filter((s) => !had.has(s));
  if (gained.length) {
    const words = { screen: 'share your screen', mic: 'speak', camera: 'turn on your camera' };
    toast(`🎉 The presenter invited you to ${gained.map((g) => words[g]).join(', ')}.`, 'success', 7000);
  }
  if (!now2.has('screen') && S.local.screen) media(async () => stopScreen());
  if (!now2.has('mic') && S.local.mic) media(async () => stopLocal('mic'));
  if (!now2.has('camera') && S.local.camera) media(async () => stopLocal('camera'));
  if (had.size && !now2.size) toast('The presenter has taken you off stage.', 'info');
  const blocked = chatBlocked();
  if (S.wasBlocked !== undefined && S.wasBlocked !== blocked) toast(blocked ? 'The presenter has muted you in chat.' : 'You can chat again.', 'info');
  S.wasBlocked = blocked;
}

function mediaError(err) {
  if (!err) return;
  console.warn(err);
  const msg = err.name === 'NotAllowedError' ? 'Permission denied — allow access in your browser’s address bar.'
    : err.name === 'NotFoundError' ? 'No device found.'
      : err.name === 'NotReadableError' ? 'Your device is in use by another app.'
        : err.message || String(err);
  toast(msg, 'error', 6000);
}

// ── Ending ─────────────────────────────────────────────────
function teardown() {
  S.timers.forEach(clearInterval);
  for (const p of S.pulls.values()) { p.handle.stop(); p.audio?.remove(); }
  S.pulls.clear();
  for (const k of Object.keys(S.local)) { S.local[k].handle?.stop(); S.local[k].track?.stop(); }
  S.local = {};
  S.data?.shutdown();
}

function endClass(reason) {
  if (S.ended) return;
  S.ended = true;
  if (!IS_HOST) sendUp({ t: 'bye' });
  teardown();
  $('#lv-app').dataset.state = 'ended';
  showReconnect(false);
  const ov = $('#lv-overlay');
  ov.replaceChildren();
  ov.classList.remove('hidden');
  const map = {
    ended: ['The class has ended', CFG.CLOSING_MESSAGE || 'Thanks for attending.', '🎯'],
    removed: ['You were removed from the class', 'The presenter removed you from this session.', '👋'],
    left: ['You left the class', 'Thanks for joining!', '👋'],
  };
  const [title, text, emoji] = map[reason] || map.left;
  ov.append(h('div', { class: 'lv-card center' },
    h('div', { class: 'lv-end-emoji' }, emoji),
    h('h1', {}, title), h('p', { class: 'muted' }, text),
    h('div', { class: 'lv-row' },
      reason === 'left' ? h('button', { class: 'lv-btn primary', onclick: () => location.reload() }, 'Rejoin') : null,
      h('a', { class: 'lv-btn', href: IS_HOST ? 'host-room.html' : 'index.html' }, IS_HOST ? 'Back to studio' : 'Return to homepage'))));
}

function confirmEnd() {
  modal({
    title: 'End the class?',
    body: h('p', {}, 'Everyone will be disconnected and see the closing message. You can also just leave and come back — attendees wait for you.'),
    actions: [
      { label: 'Leave (keep room open)', run: () => endClass('left') },
      { label: 'End for everyone', kind: 'danger', run: endForAll },
    ],
  });
}

async function endForAll() {
  try { await api('host-update', { token: S.token, open: false }); } catch (e) { toast(`Could not end: ${e.message}`, 'error'); return false; }
  for (let i = 0; i < 3; i++) setTimeout(() => sendRoom({ t: 'end' }), i * 300);
  markSupabaseSession(S.room, false);
  sessionStorage.removeItem(`lv_host_${S.room}`);
  setTimeout(() => endClass('ended'), 1000);
  return true;
}

// ── Settings ───────────────────────────────────────────────
function applySettings(before = {}) {
  const s = S.settings;
  $('#lv-title').textContent = s.title || CFG.CLASS_TITLE || 'Live Class';
  document.title = `${s.title || CFG.CLASS_TITLE || 'Live Class'} · ${IS_HOST ? 'Presenter' : 'Live'}`;
  const banner = $('#lv-banner');
  banner.classList.toggle('hidden', !s.banner);
  banner.replaceChildren();
  if (s.banner) {
    banner.append(h('span', { class: 'lv-banner-ico', html: icon('pin', 16) }), h('span', { class: 'lv-banner-text' }, linkify(s.banner)));
    if (IS_HOST) banner.append(h('button', { class: 'lv-icon-btn sm', title: 'Unpin', html: icon('x', 16), onclick: () => updateSettings({ banner: '' }) }));
  }
  $('#lv-locked').classList.toggle('hidden', !s.locked);
  if (!IS_HOST && before.chat) {
    if (before.chat !== s.chat) toast(s.chat === 'off' ? 'The presenter turned chat off.' : s.chat === 'to-host' ? 'Chat is now private questions to the presenter.' : 'Chat is open to everyone.', 'info');
    if (before.reactions && !s.reactions) toast('Reactions are turned off.', 'info');
    if (s.banner && s.banner !== before.banner) toast('📌 New announcement from the presenter', 'info');
  }
  renderChatComposer();
  renderControls();
  if (IS_HOST) syncRoomPanel();
}

async function updateSettings(patch) {
  const prev = S.settings;
  S.settings = { ...S.settings, ...patch };
  applySettings(prev);
  stateChanged();
  if ('locked' in patch || 'title' in patch) {
    try { await api('host-update', { token: S.token, ...('locked' in patch ? { locked: patch.locked } : {}), ...('title' in patch ? { title: patch.title } : {}) }); }
    catch (e) { toast(`Could not save: ${e.message}`, 'error'); }
  }
}

function tickTimer() {
  const start = S.startedAt;
  if (!start) return;
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hh = Math.floor(sec / 3600); const mm = Math.floor((sec % 3600) / 60); const ss = sec % 60;
  $('#lv-timer').textContent = `${hh ? `${hh}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function updateCount() {
  $('#lv-count').textContent = IS_HOST ? onlinePeople().length + 1 : (S.view?.count || 1);
}

// Presenter: survive a page refresh without losing chat, polls and settings.
function saveHostState() {
  if (!IS_HOST || !S.room) return;
  schedule('save', () => {
    try {
      sessionStorage.setItem(`lv_host_${S.room}`, JSON.stringify({
        settings: S.settings, messages: S.messages.slice(-200), polls: S.polls, poll: S.poll,
        results: [...S.results.entries()], votes: [...S.votes.entries()].map(([k, m]) => [k, [...m.entries()]]),
        people: [...S.people.values()].map((p) => ({ identity: p.identity, grants: [...p.grants], blocked: p.blocked })),
      }));
    } catch { /* storage unavailable */ }
  }, 1000);
}

function restoreHostState() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(`lv_host_${S.room}`) || 'null'); } catch { saved = null; }
  if (!saved) return;
  S.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  S.messages = saved.messages || [];
  S.polls = saved.polls || [];
  S.poll = saved.poll || null;
  S.results = new Map(saved.results || []);
  S.votes = new Map((saved.votes || []).map(([k, e]) => [k, new Map(e)]));
  S.restoredPeople = new Map((saved.people || []).map((p) => [p.identity, p]));
  renderChat();
}

// ── Stage ──────────────────────────────────────────────────
function videoEl(track, cls) {
  let el = S.videoEls.get(track.id);
  if (!el) {
    el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    el.srcObject = new MediaStream([track]);
    S.videoEls.set(track.id, el);
    track.addEventListener('ended', () => S.videoEls.delete(track.id));
  }
  el.className = cls;
  if (el.paused) el.play().catch(() => {});
  return el;
}

function setOnly(container, node) {
  if (container.childNodes.length === 1 && container.firstChild === node) return;
  container.replaceChildren(node);
}

// Who is on screen right now: the most recent screen share wins.
function currentShare() {
  const v = S.view;
  if (!v) return null;
  const list = [];
  if (v.host.sharing) list.push({ id: HOST_ID, name: v.host.name, at: v.host.shareAt });
  for (const s of v.stage || []) if (s.sharing) list.push({ id: s.id, name: s.name, at: s.shareAt });
  return list.sort((a, b) => b.at - a.at)[0] || null;
}

function trackFor(id, kind) {
  if (id === S.identity) return S.local[kind]?.track || null;
  return pulled(id, kind);
}

function renderStage() {
  if (!S.live || !S.view) return;
  const main = $('#lv-main');
  const pip = $('#lv-pip');
  const label = $('#lv-stage-label');
  const strip = $('#lv-strip');
  const v = S.view;
  const share = currentShare();
  const hostCam = v.host.camOn ? trackFor(HOST_ID, 'camera') : null;
  const shown = new Set();
  let labelText = '';

  if (share) {
    shown.add(share.id);
    const track = trackFor(share.id, 'screen');
    if (share.id === S.identity && track) {
      setOnly(main, presentingCard(track));
    } else if (track) {
      setOnly(main, videoEl(track, 'lv-video contain'));
      labelText = `${share.id === HOST_ID ? '' : '🖥 '}${share.name} is presenting`;
    } else {
      setPlaceholder(main, `load-${share.id}`, h('div', { class: 'lv-placeholder' }, h('div', { class: 'lv-spin lg' }), h('div', { class: 'lv-ph-sub' }, `Loading ${share.name}’s screen…`)));
    }
  } else if (hostCam) {
    shown.add(HOST_ID);
    setOnly(main, videoEl(hostCam, `lv-video cover${IS_HOST ? ' mirror' : ''}`));
    labelText = v.host.name;
  } else {
    shown.add(HOST_ID);
    const waiting = !IS_HOST && !S.lastStateAt;
    setPlaceholder(main, waiting ? 'waiting' : 'host', waiting
      ? h('div', { class: 'lv-placeholder' }, h('div', { class: 'lv-spin lg' }), h('div', { class: 'lv-ph-name' }, 'Connecting to the class…'), h('div', { class: 'lv-ph-sub' }, 'This takes a few seconds.'))
      : h('div', { class: 'lv-placeholder', 'data-speaker': HOST_ID },
        avatar(v.host.name, HOST_ID, 'xl'),
        h('div', { class: 'lv-ph-name' }, IS_HOST ? 'You' : v.host.name),
        h('div', { class: 'lv-ph-sub' }, IS_HOST ? 'Turn on your camera or share your screen to start presenting' : v.host.micOn ? 'Presenting with audio' : 'The presenter will start shortly')));
  }
  label.textContent = labelText;
  label.classList.toggle('hidden', !labelText);

  if (share && hostCam) {
    shown.add(HOST_ID);
    pip.classList.remove('hidden');
    setOnly(pip, videoEl(hostCam, `lv-video cover${IS_HOST ? ' mirror' : ''}`));
  } else {
    pip.classList.add('hidden');
    pip.replaceChildren();
  }

  // Strip: co-presenters, plus the presenter if not visible elsewhere.
  const tiles = [];
  if (!shown.has(HOST_ID)) tiles.push({ id: HOST_ID, name: v.host.name, micOn: v.host.micOn, camOn: v.host.camOn });
  for (const s of v.stage || []) tiles.push({ id: s.id, name: s.name, micOn: s.micOn, camOn: s.camOn });
  const keep = new Set();
  for (const t of tiles) {
    keep.add(t.id);
    let tile = strip.querySelector(`[data-tile="${CSS.escape(t.id)}"]`);
    if (!tile) strip.append(tile = h('div', { class: 'lv-tile', 'data-tile': t.id, 'data-speaker': t.id }));
    const cam = t.camOn ? trackFor(t.id, 'camera') : null;
    const body = cam ? videoEl(cam, `lv-video cover${t.id === S.identity ? ' mirror' : ''}`) : avatar(t.name, t.id, 'md');
    const nameRow = h('div', { class: 'lv-tile-name' },
      h('span', { class: 'lv-mic', html: icon(t.micOn ? 'mic' : 'micOff', 12) }),
      `${t.id === S.identity ? 'You' : t.name}${t.id === HOST_ID ? ' · Presenter' : ''}`);
    if (tile.firstChild !== body) tile.replaceChildren(body, nameRow);
    else tile.replaceChild(nameRow, tile.lastChild);
  }
  strip.querySelectorAll('[data-tile]').forEach((t) => { if (!keep.has(t.dataset.tile)) t.remove(); });
  strip.classList.toggle('hidden', keep.size === 0);
  $('#lv-stage').classList.toggle('sharing', !!share);
}

function setPlaceholder(main, key, node) {
  if (main.dataset.key === key && main.firstChild?.classList?.contains('lv-placeholder')) return;
  main.dataset.key = key;
  main.replaceChildren(node);
}

function presentingCard(track) {
  if (S.presentingCard?.id === track.id) return S.presentingCard.el;
  const el = h('div', { class: 'lv-presenting' },
    h('div', { class: 'lv-presenting-preview' }, videoEl(track, 'lv-video contain')),
    h('div', { class: 'lv-presenting-text' },
      h('strong', {}, 'You’re presenting to everyone'),
      h('span', { class: 'muted' }, 'Attendees see your shared screen live.'),
      h('button', { class: 'lv-btn danger', onclick: toggleScreen, html: `${icon('screenOff', 18)} Stop presenting` })));
  S.presentingCard = { id: track.id, el };
  return el;
}

// ── Controls bar ───────────────────────────────────────────
function ctrl(id, iconName, label, { active, off, on, badge, disabled, title } = {}) {
  return h('button', {
    class: `lv-ctrl${active ? ' active' : ''}${off ? ' off' : ''}`,
    id: `ctl-${id}`, title: title || label, 'aria-label': label, 'aria-pressed': active ? 'true' : null, disabled,
    onclick: on,
  }, h('span', { class: 'lv-ctrl-ico', html: icon(iconName, 22) }),
  h('span', { class: 'lv-ctrl-label' }, label),
  badge ? h('span', { class: 'lv-ctrl-badge' }, badge) : null);
}

function renderControls() {
  if (!S.live) return;
  const bar = $('#lv-controls');
  const s = S.settings;
  const l = S.local;
  const left = h('div', { class: 'lv-ctl-group' });
  const center = h('div', { class: 'lv-ctl-group center' });
  const right = h('div', { class: 'lv-ctl-group right' });

  if (can('mic')) {
    const on = !!l.mic?.on;
    center.append(ctrl('mic', on ? 'mic' : 'micOff', on ? 'Mute' : 'Unmute', { off: !on, on: toggleMic }));
  }
  if (can('camera')) {
    const on = !!l.camera;
    center.append(ctrl('cam', on ? 'cam' : 'camOff', on ? 'Stop video' : 'Start video', { off: !on, on: toggleCam }));
  }
  if (can('screen')) {
    const on = !!l.screen;
    center.append(ctrl('screen', on ? 'screenOff' : 'screen', on ? 'Stop share' : 'Share screen', { active: on, on: toggleScreen }));
  }
  if (!IS_HOST && s.hands) {
    const up = myHandUp();
    center.append(ctrl('hand', 'hand', up ? 'Lower hand' : 'Raise hand', { active: up, on: () => { sendUp({ t: 'hand', up: !up }); toast(up ? 'Hand lowered' : '✋ Hand raised — the presenter can see it', 'info', 2500); } }));
  }
  if (s.reactions || IS_HOST) {
    center.append(ctrl('react', 'smile', 'React', { on: (e) => reactionPicker(e.currentTarget), disabled: chatBlocked() }));
  }
  const hands = S.view?.hands?.length || 0;
  center.append(ctrl('chat', 'chat', 'Chat', { active: S.panel === 'chat', on: () => openPanel('chat'), badge: S.unread ? String(Math.min(S.unread, 99)) : null }));
  center.append(ctrl('people', 'users', 'People', { active: S.panel === 'people', on: () => openPanel('people'), badge: IS_HOST && hands ? String(hands) : null }));
  center.append(ctrl('polls', 'poll', 'Polls', { active: S.panel === 'polls', on: () => openPanel('polls'), badge: !IS_HOST && S.poll?.open && !S.myVotes.has(S.poll.id) ? '1' : null }));
  if (IS_HOST) center.append(ctrl('room', 'sliders', 'Controls', { active: S.panel === 'room', on: () => openPanel('room') }));

  left.append(h('button', { class: 'lv-icon-btn', title: 'Audio & video settings', 'aria-label': 'Settings', html: icon('settings'), onclick: deviceSettings }));
  right.append(IS_HOST
    ? h('button', { class: 'lv-btn danger', id: 'ctl-end', onclick: confirmEnd, html: `${icon('phone', 18)}<span class="lv-ctrl-label">End class</span>` })
    : h('button', { class: 'lv-btn danger', id: 'ctl-leave', onclick: () => endClass('left'), html: `${icon('phone', 18)}<span class="lv-ctrl-label">Leave</span>` }));
  bar.replaceChildren(left, center, right);
}

// ── Reactions ──────────────────────────────────────────────
function reactionPicker(anchor) {
  closePopovers();
  const pop = h('div', { class: 'lv-popover lv-react-pop', role: 'menu' },
    REACTIONS.map((e) => h('button', { class: 'lv-emoji', 'aria-label': `React ${e}`, onclick: () => sendReaction(e) }, e)));
  placePopover(pop, anchor);
}

function placePopover(pop, anchor) {
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
  setTimeout(() => document.addEventListener('click', closePopovers, { once: true }), 0);
}

function closePopovers() {
  document.querySelectorAll('.lv-popover').forEach((p) => p.remove());
}

function sendReaction(e) {
  const t = Date.now();
  if (t - S.lastReactionAt < 400) return;
  S.lastReactionAt = t;
  showReaction(e, 'You');
  if (IS_HOST) S.pendingReactions.push([e, S.name]);
  else sendUp({ t: 'react', e });
}

function showReaction(e, who) {
  const box = $('#lv-reactions');
  if (!box || box.childElementCount > 40) return; // cap on-screen bubbles during reaction storms
  const el = h('div', { class: 'lv-float', style: `--x:${Math.round(Math.random() * 70)}px;--d:${(2.6 + Math.random()).toFixed(2)}s` },
    h('span', { class: 'lv-float-emoji' }, e), who ? h('span', { class: 'lv-float-who' }, who) : null);
  box.append(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Chat ───────────────────────────────────────────────────
function buildChatPanel() {
  $('#panel-chat').append(
    h('div', { class: 'lv-chat-list', id: 'lv-chat-list', role: 'log', 'aria-live': 'polite' },
      h('div', { class: 'lv-empty', id: 'lv-chat-empty' }, 'Messages will appear here. Say hello 👋')),
    h('div', { class: 'lv-composer', id: 'lv-composer' }));
  renderChatComposer();
}

function renderChatComposer() {
  const box = $('#lv-composer');
  if (!box) return;
  const mode = S.settings.chat;
  const blocked = chatBlocked();
  const disabled = !IS_HOST && (mode === 'off' || blocked);
  const note = IS_HOST
    ? (mode === 'off' ? 'Chat is off for attendees' : mode === 'to-host' ? 'Attendees send private questions to you' : 'Everyone can chat')
    : blocked ? 'The presenter has muted you in chat'
      : mode === 'off' ? 'The presenter has turned chat off'
        : mode === 'to-host' ? 'Your messages go privately to the presenter' : 'Messages are visible to everyone';
  const key = `${mode}|${disabled}|${note}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const prevText = $('#lv-chat-input')?.value || '';
  const input = h('textarea', { class: 'lv-chat-input', id: 'lv-chat-input', rows: 1, maxlength: 500, placeholder: disabled ? 'Chat is unavailable' : mode === 'to-host' && !IS_HOST ? 'Ask the presenter a question…' : 'Send a message…', disabled, 'aria-label': 'Chat message' });
  input.value = disabled ? '' : prevText;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; });
  box.replaceChildren(
    h('div', { class: `lv-chat-note${disabled ? ' warn' : ''}` }, note),
    h('div', { class: 'lv-composer-row' },
      h('button', { class: 'lv-icon-btn', title: 'Emoji', 'aria-label': 'Insert emoji', disabled, html: icon('smile'), onclick: (e) => emojiPicker(e.currentTarget) }),
      input,
      h('button', { class: 'lv-icon-btn primary', title: 'Send', 'aria-label': 'Send message', disabled, html: icon('send', 18), onclick: sendChat })));
}

function emojiPicker(anchor) {
  closePopovers();
  const input = $('#lv-chat-input');
  const pop = h('div', { class: 'lv-popover lv-emoji-pop', onclick: (e) => e.stopPropagation() },
    CHAT_EMOJI.map((e) => h('button', { class: 'lv-emoji sm', onclick: () => {
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + e + input.value.slice(input.selectionEnd ?? at);
      input.focus();
      input.selectionStart = input.selectionEnd = at + e.length;
    } }, e)));
  placePopover(pop, anchor);
}

function sendChat() {
  const input = $('#lv-chat-input');
  const text = input.value.trim();
  if (!text) return;
  const mode = S.settings.chat;
  if (!IS_HOST && (mode === 'off' || chatBlocked())) return;
  const priv = !IS_HOST && mode === 'to-host';
  const m = { id: uid().slice(0, 24), from: S.identity, name: S.name, text: text.slice(0, 500), ts: Date.now(), priv, host: IS_HOST };
  if (IS_HOST) {
    sendRoom({ t: 'chat', m });
    saveHostState();
  } else if (!sendUp({ t: 'chat', id: m.id, text: m.text, priv })) {
    toast('Not connected yet — try again in a moment.', 'warn');
    return;
  }
  addMessage({ ...m, mine: true });
  input.value = '';
  input.style.height = 'auto';
}

function addMessage(m, deferRender) {
  if (!m || typeof m.text !== 'string') return;
  const existing = S.messages.find((x) => x.id === m.id);
  if (existing) return;
  if (m.from === S.identity) m.mine = true;
  S.messages.push(m);
  if (S.messages.length > MAX_CHAT) S.messages.splice(0, S.messages.length - MAX_CHAT);
  if (!m.mine && !m.quiet && S.panel !== 'chat') { S.unread++; updateBadges(); renderControls(); }
  if (!deferRender) {
    const list = $('#lv-chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    $('#lv-chat-empty')?.remove();
    list.append(messageEl(m));
    while (list.childElementCount > MAX_CHAT) list.firstChild.remove();
    if (nearBottom || m.mine) scrollChat();
  }
}

function removeMessage(id) {
  S.messages = S.messages.filter((m) => m.id !== id);
  document.querySelector(`[data-msg="${CSS.escape(String(id))}"]`)?.remove();
}

function renderChat() {
  const list = $('#lv-chat-list');
  if (!list) return;
  S.messages.sort((a, b) => a.ts - b.ts);
  list.replaceChildren(...(S.messages.length ? S.messages.map(messageEl) : [h('div', { class: 'lv-empty', id: 'lv-chat-empty' }, 'Messages will appear here. Say hello 👋')]));
  scrollChat();
}

function scrollChat() {
  const list = $('#lv-chat-list');
  if (list) list.scrollTop = list.scrollHeight;
}

function messageEl(m) {
  let tools = null;
  if (IS_HOST) {
    const del = !m.priv ? h('button', { class: 'lv-icon-btn sm', title: 'Delete for everyone', html: icon('trash', 14), onclick: () => { removeMessage(m.id); sendRoom({ t: 'chat-del', id: m.id }); saveHostState(); } }) : null;
    const pin = h('button', { class: 'lv-icon-btn sm', title: 'Pin as announcement', html: icon('pin', 14), onclick: () => updateSettings({ banner: m.mine ? m.text : `${m.name}: ${m.text}` }) });
    const mute = !m.mine && m.from !== HOST_ID ? h('button', { class: 'lv-icon-btn sm', title: 'Mute in chat', html: icon('micOff', 14), onclick: () => setChatBlocked(m.from, true) }) : null;
    tools = h('div', { class: 'lv-msg-tools' }, pin, mute, del);
  }
  return h('div', { class: `lv-msg${m.host ? ' host' : ''}${m.priv ? ' priv' : ''}${m.mine ? ' mine' : ''}`, 'data-msg': m.id },
    avatar(m.name, m.from, 'sm'),
    h('div', { class: 'lv-msg-body' },
      h('div', { class: 'lv-msg-head' },
        h('span', { class: 'lv-msg-name' }, m.mine ? 'You' : m.name),
        m.host ? h('span', { class: 'lv-tag' }, 'Presenter') : null,
        m.priv ? h('span', { class: 'lv-tag priv' }, m.mine ? 'to presenter' : 'private') : null,
        h('span', { class: 'lv-msg-time' }, fmtTime(m.ts))),
      h('div', { class: 'lv-msg-text' }, linkify(m.text))),
    tools);
}

function updateBadges() {
  const chat = $('#badge-chat');
  chat.textContent = S.unread > 99 ? '99+' : S.unread;
  chat.classList.toggle('hidden', !S.unread);
  const hands = S.view?.hands?.length || 0;
  const people = $('#badge-people');
  people.textContent = hands;
  people.classList.toggle('hidden', !IS_HOST || !hands);
  const hc = $('#lv-hands-count');
  if (hc) { hc.textContent = hands; $('#lv-hands-pill').classList.toggle('alert', hands > 0); }
}

// ── People ─────────────────────────────────────────────────
function buildPeoplePanel() {
  const search = h('input', { class: 'lv-input sm', type: 'search', placeholder: 'Search people', 'aria-label': 'Search people' });
  search.addEventListener('input', () => { S.peopleFilter = search.value.toLowerCase(); renderPeople(); });
  $('#panel-people').append(
    h('div', { class: 'lv-people-head' }, search,
      IS_HOST ? h('button', { class: 'lv-btn sm', title: 'Lower all hands', onclick: lowerAllHands }, 'Lower all ✋') : null),
    h('div', { class: 'lv-people', id: 'lv-people' }));
}

// rows: { id, name, hand, stage:[sources], blocked, sharing, micOn, camOn }
function peopleRows() {
  const v = S.view || {};
  const hands = new Set(v.hands || []);
  const blocked = new Set(v.blocked || []);
  const stage = new Map((v.stage || []).map((s) => [s.id, s]));
  const host = { id: HOST_ID, name: v.host?.name || 'Presenter', hand: 0, stage: SOURCES, host: true, sharing: v.host?.sharing, micOn: v.host?.micOn, camOn: v.host?.camOn };
  let list;
  if (IS_HOST) {
    list = onlinePeople().map((p) => ({ id: p.identity, name: p.name, hand: p.hand, stage: [...p.grants], blocked: p.blocked, sharing: p.grants.has('screen') && p.sharing, micOn: p.grants.has('mic') && p.micOn, camOn: p.grants.has('camera') && p.camOn }));
  } else if (v.roster) {
    list = v.roster.map(([id, name]) => {
      const st = stage.get(id);
      return { id, name, hand: hands.has(id) ? 1 : 0, stage: st?.sources || [], blocked: blocked.has(id), sharing: st?.sharing, micOn: st?.micOn, camOn: st?.camOn };
    });
  } else {
    list = (v.stage || []).map((st) => ({ id: st.id, name: st.name, hand: 0, stage: st.sources, sharing: st.sharing, micOn: st.micOn, camOn: st.camOn }));
    if (myHandUp() && !list.some((r) => r.id === S.identity)) list.push({ id: S.identity, name: S.name, hand: 1, stage: [] });
  }
  return [host, ...list];
}

function renderPeople() {
  updateBadges();
  const box = $('#lv-people');
  if (!box || !S.live || S.panel !== 'people') return;
  const f = S.peopleFilter;
  const all = peopleRows().filter((p) => !f || (p.name || '').toLowerCase().includes(f));
  const hands = all.filter((p) => p.hand).sort((a, b) => a.hand - b.hand);
  const stage = all.filter((p) => (p.host || p.stage.length) && !p.hand);
  const rest = all.filter((p) => !p.host && !p.stage.length && !p.hand).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const full = IS_HOST || S.settings.showPeople;
  const sections = [];
  if (hands.length) sections.push(section(IS_HOST || full ? `Raised hands · ${hands.length}` : 'Your hand is raised', hands));
  sections.push(section(`Presenters · ${stage.length}`, stage));
  if (full) sections.push(section(`Attendees · ${rest.length}`, rest.slice(0, 400)));
  else sections.push(h('div', { class: 'lv-people-note' }, `${S.view?.count || 1} people are in this class. The presenter has hidden the attendee list.`));
  box.replaceChildren(...sections);

  function section(title, list) {
    return h('div', { class: 'lv-people-sec' }, h('div', { class: 'lv-people-title' }, title),
      list.length ? list.map(personRow) : h('div', { class: 'lv-people-none' }, 'No one yet'));
  }
}

function personRow(p) {
  const badges = [];
  if (p.hand) badges.push(h('span', { class: 'lv-hand-badge', title: 'Hand raised' }, '✋'));
  if (p.sharing) badges.push(h('span', { class: 'lv-state', title: 'Sharing screen', html: icon('screen', 14) }));
  if (p.camOn) badges.push(h('span', { class: 'lv-state', title: 'Camera on', html: icon('cam', 14) }));
  if (p.host || p.stage.includes('mic')) badges.push(h('span', { class: `lv-state${p.micOn ? ' on' : ''}`, title: p.micOn ? 'Mic on' : 'Mic off', html: icon(p.micOn ? 'mic' : 'micOff', 14) }));
  if (p.blocked) badges.push(h('span', { class: 'lv-state warn', title: 'Muted in chat', html: icon('chat', 14) }));
  return h('div', { class: 'lv-person', 'data-person': p.id },
    avatar(p.name, p.id, 'sm'),
    h('div', { class: 'lv-person-name' }, p.id === S.identity ? `${p.name} (you)` : p.name,
      p.host ? h('span', { class: 'lv-tag' }, 'Presenter') : p.stage.length ? h('span', { class: 'lv-tag alt' }, 'On stage') : null),
    h('div', { class: 'lv-person-badges' }, badges),
    IS_HOST && !p.host ? h('button', { class: 'lv-icon-btn sm', 'aria-label': `Actions for ${p.name}`, title: 'Actions', html: icon('more', 18), onclick: (e) => { e.stopPropagation(); personMenu(p.id, e.currentTarget); } }) : null);
}

// Presenter actions on one attendee
function setGrants(id, sources, msg) {
  const p = S.people.get(id);
  if (!p) return;
  p.grants = new Set(sources);
  if (p.grants.size && p.hand) p.hand = 0;
  if (!p.grants.has('screen')) p.sharing = false;
  if (msg) toast(msg, 'success');
  stateChanged();
  reconcilePulls();
}

function setChatBlocked(id, blocked) {
  const p = S.people.get(id);
  if (!p) return;
  p.blocked = blocked;
  toast(blocked ? `${p.name} can no longer chat` : `${p.name} can chat again`, 'info');
  stateChanged();
}

function personMenu(id, anchor) {
  closePopovers();
  const p = S.people.get(id);
  if (!p) return;
  const has = (k) => p.grants.has(k);
  const toggled = (k) => { const s = new Set(p.grants); s.has(k) ? s.delete(k) : s.add(k); return s; };
  const act = (fn) => () => { closePopovers(); fn(); };
  const item = (label, fn, cls = '') => h('button', { class: `lv-menu-item ${cls}`, role: 'menuitem', onclick: act(fn) }, label);
  const items = [
    h('div', { class: 'lv-menu-title' }, p.name),
    item(has('screen') ? '✓ Can share screen' : 'Allow screen share', () => setGrants(id, toggled('screen'), has('screen') ? null : `${p.name} can now share their screen`)),
    item(has('mic') ? '✓ Can speak (mic)' : 'Allow to speak (mic)', () => setGrants(id, toggled('mic'), has('mic') ? null : `${p.name} can now unmute`)),
    item(has('camera') ? '✓ Can use camera' : 'Allow camera', () => setGrants(id, toggled('camera'))),
    item('Make co-presenter (all)', () => setGrants(id, SOURCES, `${p.name} is now a co-presenter`)),
    p.grants.size ? item('Take off stage', () => setGrants(id, [], `${p.name} was taken off stage`)) : null,
    h('div', { class: 'lv-menu-sep' }),
    p.micOn && has('mic') ? item('Mute microphone', () => sendRoom({ t: 'mute', id })) : null,
    p.sharing ? item('Stop their screen share', () => sendRoom({ t: 'stop-share', id })) : null,
    p.hand ? item('Lower hand', () => { p.hand = 0; sendRoom({ t: 'lower-hand', who: id }); stateChanged(); }) : null,
    item(p.blocked ? 'Allow chat again' : 'Mute in chat', () => setChatBlocked(id, !p.blocked)),
    item('Remove from class', () => {
      modal({ title: `Remove ${p.name}?`, body: h('p', {}, 'They will be disconnected and can’t rejoin this class.'),
        actions: [{ label: 'Cancel' }, { label: 'Remove', kind: 'danger', run: () => removePerson(id) }] });
    }, 'danger'),
  ];
  const pop = h('div', { class: 'lv-popover lv-menu', role: 'menu', onclick: (e) => e.stopPropagation() }, items.filter(Boolean));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8))}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener('click', closePopovers, { once: true }), 0);
}

async function removePerson(id) {
  const p = S.people.get(id);
  try { await api('host-update', { token: S.token, ban: id }); } catch (e) { toast(`Could not remove: ${e.message}`, 'error'); return false; }
  for (let i = 0; i < 3; i++) setTimeout(() => sendRoom({ t: 'kick', id }), i * 400);
  if (p) {
    p.left = true;
    p.grants.clear();
    if (p.ch) { S.data.close([p.ch.sfuId]); p.ch = null; }
    S.people.delete(id);
  }
  stateChanged();
  reconcilePulls();
  return true;
}

function lowerAllHands() {
  for (const p of S.people.values()) p.hand = 0;
  sendRoom({ t: 'lower-hand', who: '*' });
  stateChanged();
  toast('All hands lowered', 'info');
}

// ── Polls ──────────────────────────────────────────────────
function renderPolls() {
  const panel = $('#panel-polls');
  if (!panel) return;
  const kids = [];
  if (IS_HOST) {
    kids.push(pollComposer());
    if (S.poll) kids.push(pollCard(S.poll));
    const past = S.polls.filter((p) => p.id !== S.poll?.id).slice().reverse();
    if (past.length) kids.push(h('div', { class: 'lv-people-title' }, 'Earlier polls'), ...past.map(pollCard));
  } else if (S.poll) {
    kids.push(pollCard(S.poll));
  } else {
    kids.push(h('div', { class: 'lv-empty' }, 'No poll right now. When the presenter launches one, it appears here.'));
  }
  panel.replaceChildren(h('div', { class: 'lv-polls' }, kids));
}

function pollComposer() {
  if (S.pollDraft) return S.pollDraft;
  const q = h('input', { class: 'lv-input sm', maxlength: 200, placeholder: 'Ask a question…', 'aria-label': 'Poll question' });
  const opts = h('div', { class: 'lv-poll-opts' });
  const addOpt = (val = '') => {
    if (opts.childElementCount >= 6) return;
    opts.append(h('input', { class: 'lv-input sm', maxlength: 80, placeholder: `Option ${opts.childElementCount + 1}`, value: val }));
  };
  addOpt('Yes'); addOpt('No');
  const showResults = h('input', { type: 'checkbox', checked: true });
  const el = h('div', { class: 'lv-card-sm' },
    h('div', { class: 'lv-people-title' }, 'New poll'), q, opts,
    h('button', { class: 'lv-link-btn', onclick: () => addOpt(), html: `${icon('plus', 14)} Add option` }),
    h('label', { class: 'lv-check sm' }, showResults, 'Show live results to attendees'),
    h('button', { class: 'lv-btn primary sm', onclick: () => {
      const options = [...opts.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
      if (!q.value.trim() || options.length < 2) { toast('Add a question and at least two options.', 'warn'); return; }
      if (S.poll?.open) closePoll();
      const poll = { id: uid().slice(0, 12), q: q.value.trim(), options, open: true, showResults: showResults.checked };
      S.poll = poll; S.polls.push(poll); S.votes.set(poll.id, new Map());
      S.results.set(poll.id, { id: poll.id, counts: options.map(() => 0), total: 0 });
      sendRoom({ t: 'poll', poll });
      stateChanged();
      q.value = ''; opts.replaceChildren(); addOpt('Yes'); addOpt('No');
      renderPolls();
      toast('Poll launched', 'success');
    } }, 'Launch poll'));
  S.pollDraft = el;
  return el;
}

function pollCard(poll) {
  const res = S.results.get(poll.id);
  const mine = S.myVotes.get(poll.id);
  const reveal = IS_HOST || (res && (poll.showResults || !poll.open) && (mine !== undefined || !poll.open));
  const total = res?.total || 0;
  return h('div', { class: `lv-card-sm lv-poll${poll.open ? '' : ' closed'}` },
    h('div', { class: 'lv-poll-head' },
      h('span', { class: `lv-tag ${poll.open ? 'live' : ''}` }, poll.open ? 'Live poll' : 'Closed'),
      reveal ? h('span', { class: 'muted sm' }, `${total} vote${total === 1 ? '' : 's'}`) : null),
    h('div', { class: 'lv-poll-q' }, poll.q),
    poll.options.map((opt, i) => {
      const count = res?.counts?.[i] || 0;
      const pct = total ? Math.round((count / total) * 100) : 0;
      const canVote = !IS_HOST && poll.open && mine === undefined;
      return h('button', {
        class: `lv-poll-opt${mine === i ? ' chosen' : ''}`, disabled: !canVote, style: reveal ? `--pct:${pct}%` : '',
        onclick: () => {
          S.myVotes.set(poll.id, i);
          sendUp({ t: 'vote', id: poll.id, c: i });
          renderPolls(); renderControls();
        },
      }, h('span', { class: 'lv-poll-label' }, opt), reveal ? h('span', { class: 'lv-poll-pct' }, `${pct}%`) : null);
    }),
    !IS_HOST && mine !== undefined && poll.open && !poll.showResults ? h('div', { class: 'muted sm' }, 'Thanks — your vote is in. Results will be shared when the poll closes.') : null,
    IS_HOST && poll.open && poll.id === S.poll?.id ? h('button', { class: 'lv-btn sm', onclick: closePoll }, 'End poll & share results') : null);
}

function onVote(p, msg) {
  const poll = S.polls.find((x) => x.id === msg.id);
  if (!poll || !poll.open || !Number.isInteger(msg.c) || msg.c < 0 || msg.c >= poll.options.length) return;
  S.votes.get(poll.id).set(p.identity, msg.c); // one vote per person, last one wins
  const counts = poll.options.map(() => 0);
  for (const c of S.votes.get(poll.id).values()) counts[c]++;
  S.results.set(poll.id, { id: poll.id, counts, total: S.votes.get(poll.id).size });
  schedule('poll-ui', renderPolls, 300);
  if (poll.showResults) schedule('poll-results', () => broadcastResults(poll), 1000);
  saveHostState();
}

function broadcastResults(poll) {
  const r = S.results.get(poll.id);
  if (r) sendRoom({ t: 'results', id: poll.id, counts: r.counts, total: r.total });
}

function closePoll() {
  if (!S.poll) return;
  S.poll.open = false;
  sendRoom({ t: 'poll', poll: S.poll });
  broadcastResults(S.poll);
  stateChanged();
  renderPolls();
}

// ── Presenter controls panel ───────────────────────────────
function buildRoomPanel() {
  const seg = (name, options) => h('div', { class: 'lv-seg', role: 'radiogroup', 'data-setting': name },
    options.map(([value, label]) => h('button', { role: 'radio', 'data-value': value, onclick: () => updateSettings({ [name]: value }) }, label)));
  const sw = (name, label, hint) => h('label', { class: 'lv-switch-row' },
    h('span', {}, h('span', { class: 'lv-switch-label' }, label), hint ? h('span', { class: 'lv-switch-hint' }, hint) : null),
    h('input', { type: 'checkbox', class: 'lv-switch', 'data-setting': name, onchange: (e) => updateSettings({ [name]: e.target.checked }) }));
  const title = h('input', { class: 'lv-input sm', id: 'rc-title', maxlength: 120, placeholder: 'Session title' });
  const banner = h('textarea', { class: 'lv-input sm', id: 'rc-banner', rows: 2, maxlength: 280, placeholder: 'e.g. Download the workbook: https://…' });
  const invite = new URL('index.html', location.href).href;
  const group = (label, ...kids) => h('div', { class: 'lv-group' }, h('div', { class: 'lv-people-title' }, label), ...kids);

  $('#panel-room').append(h('div', { class: 'lv-room-panel' },
    group('Session',
      h('div', { class: 'lv-inline' }, title, h('button', { class: 'lv-btn sm', onclick: () => updateSettings({ title: title.value.trim() }) }, 'Save')),
      h('div', { class: 'lv-inline' },
        h('input', { class: 'lv-input sm', readonly: true, value: invite, 'aria-label': 'Invite link' }),
        h('button', { class: 'lv-btn sm', title: 'Copy invite link', html: icon('copy', 16), onclick: () => navigator.clipboard?.writeText(invite).then(() => toast('Invite link copied', 'success')) }))),
    group('Pinned announcement',
      banner,
      h('div', { class: 'lv-inline end' },
        h('button', { class: 'lv-btn sm', onclick: () => { banner.value = ''; updateSettings({ banner: '' }); } }, 'Clear'),
        h('button', { class: 'lv-btn primary sm', onclick: () => updateSettings({ banner: banner.value.trim().slice(0, 280) }) }, 'Pin'))),
    group('Chat', seg('chat', [['everyone', 'Everyone'], ['to-host', 'Questions to me'], ['off', 'Off']]),
      h('button', { class: 'lv-link-btn', onclick: exportChat, html: `${icon('download', 14)} Download chat transcript` })),
    group('Participation',
      sw('reactions', 'Emoji reactions', 'Floating reactions over the stage'),
      sw('hands', 'Raise hand', 'Attendees can ask to speak'),
      sw('showPeople', 'Show attendee list', 'Otherwise attendees only see the count'),
      sw('locked', 'Lock room', 'No new attendees can join')),
    group('Stage',
      h('div', { class: 'lv-grid2' },
        h('button', { class: 'lv-btn sm', onclick: () => { onlinePeople().forEach((p) => p.micOn && sendRoom({ t: 'mute', id: p.identity })); toast('Everyone muted', 'info'); } }, 'Mute everyone'),
        h('button', { class: 'lv-btn sm', onclick: lowerAllHands }, 'Lower all hands'),
        h('button', { class: 'lv-btn sm', onclick: () => { S.people.forEach((p) => { p.grants.clear(); p.sharing = false; }); stateChanged(); reconcilePulls(); toast('Everyone is off stage', 'info'); } }, 'Clear the stage'),
        h('button', { class: 'lv-btn sm', onclick: () => openPanel('people') }, 'Manage people'))),
    group('Session end', h('button', { class: 'lv-btn danger', onclick: confirmEnd }, 'End class for everyone'))));
  syncRoomPanel();
}

function syncRoomPanel() {
  const s = S.settings;
  document.querySelectorAll('#panel-room .lv-seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === s[seg.dataset.setting])));
  });
  document.querySelectorAll('#panel-room .lv-switch').forEach((sw) => { sw.checked = !!s[sw.dataset.setting]; });
  const title = $('#rc-title');
  if (title && document.activeElement !== title) title.value = s.title || '';
  const banner = $('#rc-banner');
  if (banner && document.activeElement !== banner) banner.value = s.banner || '';
}

function exportChat() {
  const lines = S.messages.map((m) => `[${new Date(m.ts).toLocaleString()}] ${m.name}${m.priv ? ' (private)' : ''}: ${m.text}`);
  const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' })), download: `chat-${S.room || 'class'}.txt` });
  document.body.append(a); a.click(); a.remove();
}

// ── Device settings ────────────────────────────────────────
async function deviceSettings() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* unavailable */ }
  const select = (kind, label, current, onPick) => {
    const list = devices.filter((d) => d.kind === kind && d.deviceId);
    if (!list.length) return null;
    return h('label', { class: 'lv-label' }, label,
      h('select', { class: 'lv-input sm', onchange: (e) => onPick(e.target.value) },
        list.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `${label} ${i + 1}`))));
  };
  const parts = [];
  if (can('mic')) parts.push(select('audioinput', 'Microphone', S.micId, (id) => media(async () => {
    S.micId = id;
    const cur = S.local.mic;
    if (!cur) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: true, noiseSuppression: true } });
    const t = stream.getAudioTracks()[0];
    t.enabled = cur.on;
    cur.track.stop(); cur.track = t; cur.handle.replace(t);
  })));
  if (can('camera')) parts.push(select('videoinput', 'Camera', S.camId, (id) => media(async () => {
    S.camId = id;
    const cur = S.local.camera;
    if (!cur) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const t = stream.getVideoTracks()[0];
    cur.track.stop(); cur.track = t; cur.handle.replace(t);
    renderStage();
  })));
  if ('setSinkId' in HTMLMediaElement.prototype) parts.push(select('audiooutput', 'Speaker', S.sinkId, (id) => {
    S.sinkId = id;
    document.querySelectorAll('#lv-audio-sink audio').forEach((a) => a.setSinkId(id).catch(() => {}));
  }));
  if (can('screen')) {
    parts.push(h('label', { class: 'lv-check' },
      h('input', { type: 'checkbox', checked: S.shareMotion, onchange: (e) => { S.shareMotion = e.target.checked; } }),
      'Optimise screen share for video (30 fps) instead of text & slides'));
  }
  const body = h('div', { class: 'lv-form' }, parts.filter(Boolean).length ? parts.filter(Boolean) : h('p', { class: 'muted' }, 'No devices to configure.'));
  modal({ title: 'Audio & video', body, actions: [{ label: 'Done', kind: 'primary' }] });
}

// ── Render all ─────────────────────────────────────────────
function renderAll() {
  if (IS_HOST) S.view = hostSnapshot();
  renderStage();
  renderControls();
  schedule('people', renderPeople, 250);
  updateCount();
  updateBadges();
  tickTimer();
}

window.addEventListener('beforeunload', () => { if (!IS_HOST) sendUp({ t: 'bye' }); });

shell();
showPrejoin();

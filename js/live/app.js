// ─── EEM26 Live Classroom ──────────────────────────────────
// One presenter, up to a few hundred viewers, on a LiveKit SFU.
// The same module powers the attendee room (room.html) and the
// presenter studio (host-room.html); <body data-role> picks the mode.
import * as LK from 'https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.esm.mjs';
import { icon } from './icons.js';
import { api, ApiError, supabaseClient } from './api.js';

const { Room, RoomEvent, Track, DisconnectReason, VideoPresets, ScreenSharePresets, ConnectionQuality } = LK;

const CFG = window.EEM26_CONFIG || {};
const IS_HOST = document.body.dataset.role === 'host';
const HOST_ID = 'host';
const TOPIC = 'lv';
const SRC = { camera: 1, mic: 2, screen: 3 }; // livekit protocol TrackSource values
const REACTIONS = ['👏', '❤️', '😂', '🎉', '👍', '😮', '🔥', '🙏'];
const CHAT_EMOJI = ['😀', '😂', '😍', '🙌', '👏', '👍', '🙏', '🔥', '🎉', '💯', '❤️', '😮', '🤔', '😅', '✅', '❓', '💡', '🚀', '👀', '😎', '🥳', '💪', '🤝', '✍️'];
const MAX_CHAT = 500;
const DEFAULT_SETTINGS = { chat: 'everyone', reactions: true, hands: true, locked: false, showPeople: false, banner: '', title: '' };

const enc = new TextEncoder();
const dec = new TextDecoder();
const $ = (sel, root = document) => root.querySelector(sel);

// ── State ──────────────────────────────────────────────────
const S = {
  room: null,
  token: null,
  identity: null,
  name: '',
  settings: { ...DEFAULT_SETTINGS },
  messages: [],
  unread: 0,
  panel: window.innerWidth > 900 ? 'chat' : null,
  peopleFilter: '',
  poll: null,          // current poll { id, q, options, open, showResults }
  polls: [],           // presenter: history
  votes: new Map(),    // presenter: pollId → Map(identity → choice)
  results: new Map(),  // pollId → { counts, total }
  myVotes: new Map(),  // pollId → choice
  seen: new Map(),     // trackSid → first-seen time (newest screen share wins the stage)
  videoEls: new Map(), // trackSid → <video>
  shareMotion: false,
  ending: false,
  lastReactionAt: 0,
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

// ── Participant helpers ────────────────────────────────────
function everyone() {
  return S.room ? [S.room.localParticipant, ...S.room.remoteParticipants.values()] : [];
}
function hostP() {
  if (!S.room) return null;
  return S.room.localParticipant.identity === HOST_ID ? S.room.localParticipant : S.room.remoteParticipants.get(HOST_ID) || null;
}
function isHostP(p) { return p?.identity === HOST_ID; }
function can(p, src) {
  if (isHostP(p)) return true;
  const perm = p?.permissions;
  if (!perm?.canPublish) return false;
  const list = perm.canPublishSources || [];
  return list.length === 0 || list.includes(src);
}
function onStage(p) { return !isHostP(p) && !!p?.permissions?.canPublish; }
function pubOf(p, source) {
  const pub = p?.getTrackPublication(source);
  return pub && pub.track && !pub.isMuted ? pub : null;
}
function handOf(p) { return Number(p?.attributes?.hand || 0); }
function seen(sid) {
  if (!S.seen.has(sid)) S.seen.set(sid, Date.now());
  return S.seen.get(sid);
}
function viewerCount() {
  if (!S.room) return 0;
  return Math.max(S.room.numParticipants || 0, S.room.remoteParticipants.size + 1);
}

// ── Messaging ──────────────────────────────────────────────
async function send(msg, { to, lossy } = {}) {
  if (!S.room) return;
  try {
    await S.room.localParticipant.publishData(enc.encode(JSON.stringify(msg)), {
      reliable: !lossy,
      topic: TOPIC,
      destinationIdentities: to ? [].concat(to) : undefined,
    });
  } catch (err) {
    if (!lossy) toast('Message could not be sent.', 'error');
    console.warn('publishData', err);
  }
}

async function hostOp(op, params = {}) {
  try {
    return await api('host', { token: S.token, op, ...params });
  } catch (err) {
    toast(`Action failed: ${err.message}`, 'error');
    throw err;
  }
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
        h('span', { class: 'lv-quality', id: 'lv-quality', title: 'Connection quality', html: icon('signal', 16) }))),

    h('div', { class: 'lv-body' },
      h('main', { class: 'lv-stage-wrap' },
        h('div', { class: 'lv-banner hidden', id: 'lv-banner' }),
        h('div', { class: 'lv-stage', id: 'lv-stage' },
          h('div', { class: 'lv-main', id: 'lv-main' }),
          h('div', { class: 'lv-pip hidden', id: 'lv-pip' }),
          h('div', { class: 'lv-stage-label hidden', id: 'lv-stage-label' }),
          h('div', { class: 'lv-reactions', id: 'lv-reactions', 'aria-hidden': 'true' }),
          h('button', { class: 'lv-icon-btn lv-fs', title: 'Full screen', 'aria-label': 'Full screen', html: icon('maximize'), onclick: toggleFullscreen })),
        h('div', { class: 'lv-strip', id: 'lv-strip' })),
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
    h('button', { class: 'lv-audio-unlock hidden', id: 'lv-audio-unlock', onclick: () => S.room?.startAudio(), html: `${icon('volume')} Tap to enable sound` }),
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
  const app = $('#lv-app');
  app.classList.toggle('side-open', !!S.panel);
  document.querySelectorAll('.lv-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.panel));
  document.querySelectorAll('.lv-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${S.panel}`));
  if (S.panel === 'chat') { S.unread = 0; updateBadges(); setTimeout(() => scrollChat(true), 0); }
  if (S.panel === 'people') renderPeople();
  renderControls();
}

function toggleFullscreen() {
  const stage = $('#lv-stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
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
        const res = await api('host-join', { password, room, title: titleIn.value });
        S.name = CFG.PRESENTER_NAME || 'Presenter';
        await connect(res, { mic: micIn.checked, cam: camIn.checked });
        if (titleIn.value.trim() && titleIn.value.trim() !== res.settings?.title) {
          hostOp('settings', { settings: { title: titleIn.value.trim() } }).catch(() => {});
        }
        markSupabaseSession(room, true);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          sessionStorage.removeItem('eem26_host_pw');
          location.href = 'host.html?e=1';
          return;
        }
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
    if (name.length < 2) { err.textContent = 'Please enter your name (at least 2 letters).'; err.classList.remove('hidden'); nameIn.focus(); return; }
    btn.disabled = true; btn.textContent = 'Joining…'; err.classList.add('hidden');
    localStorage.setItem('eem26_name', name);
    localStorage.setItem('eem26_pid', p.pid);
    const room = p.room || await latestRoomFromSupabase() || weekRoomName();
    try {
      const res = await api('join', { room, name, id: p.pid });
      S.name = name;
      await connect(res, {});
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Join class';
      if (e instanceof ApiError && (e.code === 'not_started' || e.code === 'locked')) {
        err.textContent = e.code === 'not_started'
          ? 'The presenter hasn’t opened the room yet. We’ll let you in automatically as soon as it opens…'
          : 'The presenter has locked the room. Retrying in a moment…';
        err.className = 'lv-error info';
        btn.textContent = 'Waiting…'; btn.disabled = true;
        retry = setTimeout(attempt, 5000);
      } else {
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

// ── Connect ────────────────────────────────────────────────
async function connect({ token, url, identity }, { mic, cam }) {
  S.token = token;
  S.identity = identity;
  const room = new Room({
    adaptiveStream: true, // viewers only pull the resolution their screen needs
    dynacast: true,       // publisher stops encoding layers nobody watches
    publishDefaults: {
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
      screenShareSimulcastLayers: [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps15],
      videoCodec: 'vp8', // universally decodable, incl. older phones
      dtx: true,
      red: true,
    },
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  S.room = room;
  bindRoom(room);
  await room.connect(url, token);
  window.__lv = S; // handy for debugging from the console

  $('#lv-overlay').classList.add('hidden');
  $('#lv-app').dataset.state = 'live';
  S.settings = parseSettings(room.metadata);
  applySettings();
  openPanel(S.panel);
  renderAll();
  setInterval(tickTimer, 1000);
  if (!room.canPlaybackAudio) $('#lv-audio-unlock').classList.remove('hidden');

  if (IS_HOST) {
    if (mic) media(() => room.localParticipant.setMicrophoneEnabled(true));
    if (cam) media(() => room.localParticipant.setCameraEnabled(true));
    toast('You’re live. Attendees can join now.', 'success');
  } else {
    hello();
  }
}

// Ask the presenter for chat history + the current poll. Retried because a
// packet sent in the first moments after joining can be dropped.
function hello() {
  clearTimeout(S.helloTimer);
  S.synced = false;
  let tries = 0;
  const ping = () => {
    if (S.synced || !S.room || tries++ >= 6 || !hostP()) return;
    send({ t: 'hello' }, { to: HOST_ID });
    S.helloTimer = setTimeout(ping, 2500);
  };
  ping();
}

function parseSettings(meta) {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(meta || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function bindRoom(room) {
  const stage = () => schedule('stage', renderStage);
  const people = () => schedule('people', renderPeople, 250);
  const both = () => { stage(); people(); renderControls(); };

  room
    .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.dataset.sid = track.sid;
        $('#lv-audio-sink').append(el);
      }
      if (track.source === Track.Source.ScreenShare) {
        seen(track.sid);
        if (p !== room.localParticipant) toast(`${p.name || 'Someone'} is sharing their screen`, 'info', 2500);
      }
      both();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      S.videoEls.delete(track.sid);
      both();
    })
    .on(RoomEvent.LocalTrackPublished, both)
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.track) { pub.track.detach(); S.videoEls.delete(pub.track.sid); }
      both();
    })
    .on(RoomEvent.TrackMuted, both)
    .on(RoomEvent.TrackUnmuted, both)
    .on(RoomEvent.TrackPublished, both)
    .on(RoomEvent.TrackUnpublished, both)
    .on(RoomEvent.ParticipantConnected, (p) => {
      people(); updateCount();
      if (isHostP(p) && !IS_HOST) { toast('The presenter has joined', 'success'); hello(); stage(); }
    })
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      people(); updateCount(); stage();
      if (isHostP(p) && !IS_HOST) toast('The presenter has disconnected — hang on, they’ll be right back.', 'warn', 6000);
    })
    .on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
      if ('hand' in changed) {
        people();
        if (p === room.localParticipant) renderControls();
        if (IS_HOST && handOf(p)) { toast(`✋ ${p.name} raised their hand`, 'info', 3500); beep(); }
        updateBadges();
      }
    })
    .on(RoomEvent.ParticipantPermissionsChanged, (prev, p) => {
      if (p === room.localParticipant) onMyPermissions(prev);
      both();
    })
    .on(RoomEvent.ParticipantNameChanged, people)
    .on(RoomEvent.RoomMetadataChanged, (meta) => {
      const before = S.settings;
      S.settings = parseSettings(meta);
      applySettings(before);
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const ids = new Set(speakers.map((s) => s.identity));
      document.querySelectorAll('[data-speaker]').forEach((el) => el.classList.toggle('speaking', ids.has(el.dataset.speaker)));
    })
    .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
      if (p !== room.localParticipant) return;
      const el = $('#lv-quality');
      el.dataset.q = q;
      el.title = `Connection: ${q}`;
      if (q === ConnectionQuality.Poor && Date.now() - (S.poorAt || 0) > 60000 && (S.poorAt = Date.now())) toast('Your connection is weak — video quality will adjust automatically.', 'warn', 3000);
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      $('#lv-audio-unlock').classList.toggle('hidden', room.canPlaybackAudio);
    })
    .on(RoomEvent.DataReceived, (payload, p, _kind, topic) => {
      if (topic !== TOPIC || !p) return;
      let msg;
      try { msg = JSON.parse(dec.decode(payload)); } catch { return; }
      onData(msg, p);
    })
    .on(RoomEvent.Reconnecting, () => showReconnect(true))
    .on(RoomEvent.Reconnected, () => { showReconnect(false); if (!IS_HOST) hello(); })
    .on(RoomEvent.Disconnected, onDisconnected)
    .on(RoomEvent.MediaDevicesError, mediaError);

  setInterval(updateCount, 3000);
}

function showReconnect(on) {
  let el = $('#lv-reconnect');
  if (on && !el) $('#lv-app').append(h('div', { class: 'lv-reconnect', id: 'lv-reconnect' }, h('span', { class: 'lv-spin' }), 'Reconnecting…'));
  if (!on && el) el.remove();
}

function onDisconnected(reason) {
  if (S.ending) return;
  const app = $('#lv-app');
  app.dataset.state = 'ended';
  const ov = $('#lv-overlay');
  ov.replaceChildren();
  ov.classList.remove('hidden');
  let title = 'You left the class';
  let text = 'Thanks for joining!';
  if (reason === DisconnectReason.ROOM_DELETED) {
    title = 'The class has ended';
    text = CFG.CLOSING_MESSAGE || 'Thanks for attending.';
  } else if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
    title = 'You were removed from the class';
    text = 'The presenter removed you from this session.';
  } else if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
    title = 'Opened in another tab';
    text = 'You joined this class from another tab or device.';
  } else if (reason !== DisconnectReason.CLIENT_INITIATED) {
    title = 'Connection lost';
    text = 'You were disconnected. Check your internet and rejoin.';
  }
  const removed = reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED;
  ov.append(h('div', { class: 'lv-card center' },
    h('div', { class: 'lv-end-emoji' }, reason === DisconnectReason.ROOM_DELETED ? '🎯' : '👋'),
    h('h1', {}, title), h('p', { class: 'muted' }, text),
    h('div', { class: 'lv-row' },
      !removed ? h('button', { class: 'lv-btn primary', onclick: () => location.reload() }, 'Rejoin') : null,
      h('a', { class: 'lv-btn', href: IS_HOST ? 'host-room.html' : 'index.html' }, IS_HOST ? 'Back to studio' : 'Return to homepage'))));
}

function mediaError(err) {
  if (!err || err.name === 'NotAllowedError' && /screen|display/i.test(err.message || '')) return;
  const msg = err.name === 'NotAllowedError' ? 'Permission denied — allow access in your browser’s address bar.'
    : err.name === 'NotFoundError' ? 'No device found.'
    : err.name === 'NotReadableError' ? 'Your device is in use by another app.'
    : err.message || String(err);
  toast(msg, 'error', 6000);
}

function onMyPermissions(prev) {
  const lp = S.room.localParticipant;
  const now = lp.permissions || {};
  const had = (src) => prev?.canPublish && ((prev.canPublishSources || []).length === 0 || prev.canPublishSources.includes(src));
  const gained = [];
  if (can(lp, SRC.screen) && !had(SRC.screen)) gained.push('share your screen');
  if (can(lp, SRC.mic) && !had(SRC.mic)) gained.push('speak');
  if (can(lp, SRC.camera) && !had(SRC.camera)) gained.push('turn on your camera');
  if (gained.length) {
    toast(`🎉 The presenter invited you to ${gained.join(', ')}.`, 'success', 7000);
    if (handOf(lp)) lp.setAttributes({ hand: '' });
  }
  // Belt and braces: the server unpublishes revoked tracks, also stop them locally.
  if (!can(lp, SRC.screen) && lp.isScreenShareEnabled) lp.setScreenShareEnabled(false).catch(() => {});
  if (!can(lp, SRC.mic) && lp.isMicrophoneEnabled) lp.setMicrophoneEnabled(false).catch(() => {});
  if (!can(lp, SRC.camera) && lp.isCameraEnabled) lp.setCameraEnabled(false).catch(() => {});
  if (prev?.canPublish && !now.canPublish) toast('The presenter has taken you off stage.', 'info');
  if (prev && prev.canPublishData !== now.canPublishData) {
    toast(now.canPublishData ? 'You can chat again.' : 'The presenter has muted you in chat.', 'info');
    renderChatComposer();
  }
}

// ── Settings (room metadata, written by the presenter) ─────
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

  if (!IS_HOST) {
    if (before.chat && before.chat !== s.chat) {
      toast(s.chat === 'off' ? 'The presenter turned chat off.' : s.chat === 'to-host' ? 'Chat is now private questions to the presenter.' : 'Chat is open to everyone.', 'info');
    }
    if (before.reactions === true && !s.reactions) toast('Reactions are turned off.', 'info');
    if (before.hands === true && !s.hands && handOf(S.room?.localParticipant)) S.room.localParticipant.setAttributes({ hand: '' });
    if (before.banner !== undefined && s.banner && s.banner !== before.banner) toast('📌 New announcement from the presenter', 'info');
  }
  renderChatComposer();
  renderControls();
  renderPeople();
  if (IS_HOST) syncRoomPanel();
}

async function updateSettings(patch) {
  const prev = S.settings;
  S.settings = { ...S.settings, ...patch };
  applySettings(prev);
  try { await hostOp('settings', { settings: patch }); }
  catch { S.settings = prev; applySettings(); }
}

function tickTimer() {
  const start = S.settings.startedAt;
  if (!start) return;
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hh = Math.floor(sec / 3600); const mm = Math.floor((sec % 3600) / 60); const ss = sec % 60;
  $('#lv-timer').textContent = `${hh ? `${hh}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function updateCount() {
  $('#lv-count').textContent = viewerCount();
}

// ── Stage ──────────────────────────────────────────────────
function videoEl(track, cls) {
  let el = S.videoEls.get(track.sid);
  if (!el) {
    el = track.attach();
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    S.videoEls.set(track.sid, el);
  }
  el.className = cls;
  return el;
}

function setOnly(container, node) {
  if (container.childNodes.length === 1 && container.firstChild === node) return;
  container.replaceChildren(node);
}

function screenShares() {
  const out = [];
  for (const p of everyone()) {
    const pub = pubOf(p, Track.Source.ScreenShare);
    if (pub) out.push({ p, pub });
  }
  return out.sort((a, b) => seen(b.pub.trackSid) - seen(a.pub.trackSid));
}

function renderStage() {
  if (!S.room) return;
  const main = $('#lv-main');
  const pip = $('#lv-pip');
  const label = $('#lv-stage-label');
  const strip = $('#lv-strip');
  const lp = S.room.localParticipant;
  const host = hostP();
  const share = screenShares()[0];
  const hostCam = pubOf(host, Track.Source.Camera);
  const shown = new Set();

  let labelText = '';
  if (share) {
    shown.add(share.p.identity);
    if (share.p === lp) {
      main.dataset.key !== 'self-share' && (main.dataset.key = 'self-share');
      setOnly(main, presentingCard(share.pub.track));
      labelText = '';
    } else {
      main.dataset.key = share.pub.trackSid;
      setOnly(main, videoEl(share.pub.track, 'lv-video contain'));
      labelText = `${isHostP(share.p) ? '' : '🖥 '}${share.p.name || 'Someone'} is presenting`;
    }
  } else if (hostCam) {
    shown.add(host.identity);
    main.dataset.key = hostCam.trackSid;
    setOnly(main, videoEl(hostCam.track, `lv-video cover${host === lp ? ' mirror' : ''}`));
    labelText = host.name;
  } else {
    if (host) shown.add(host.identity);
    const key = host ? `ph-${host.identity}` : 'waiting';
    if (main.dataset.key !== key) {
      main.dataset.key = key;
      main.replaceChildren(host
        ? h('div', { class: 'lv-placeholder', 'data-speaker': host.identity },
          avatar(host.name, host.identity, 'xl'),
          h('div', { class: 'lv-ph-name' }, host === lp ? 'You' : host.name),
          h('div', { class: 'lv-ph-sub' }, host === lp ? 'Turn on your camera or share your screen to start presenting' : 'Presenting with audio only'))
        : h('div', { class: 'lv-placeholder' },
          h('div', { class: 'lv-spin lg' }),
          h('div', { class: 'lv-ph-name' }, 'Waiting for the presenter'),
          h('div', { class: 'lv-ph-sub' }, 'Stay on this page — the class will start automatically.')));
    }
  }
  label.textContent = labelText;
  label.classList.toggle('hidden', !labelText);

  // Presenter camera picture-in-picture during a screen share
  if (share && hostCam) {
    shown.add(host.identity);
    pip.classList.remove('hidden');
    pip.dataset.speaker = host.identity;
    setOnly(pip, videoEl(hostCam.track, `lv-video cover${host === lp ? ' mirror' : ''}`));
  } else {
    pip.classList.add('hidden');
    pip.replaceChildren();
  }

  // Stage strip: everyone else who is on stage (co-presenters), plus the
  // presenter when they are not otherwise visible.
  const tiles = everyone().filter((p) => {
    if (isHostP(p)) return !shown.has(p.identity) || (share && share.p !== p && !hostCam);
    return onStage(p) || pubOf(p, Track.Source.Camera) || pubOf(p, Track.Source.Microphone);
  });
  const keep = new Set();
  for (const p of tiles) {
    keep.add(p.identity);
    let tile = strip.querySelector(`[data-tile="${CSS.escape(p.identity)}"]`);
    if (!tile) {
      tile = h('div', { class: 'lv-tile', 'data-tile': p.identity, 'data-speaker': p.identity });
      strip.append(tile);
    }
    const cam = pubOf(p, Track.Source.Camera);
    const micOn = !!pubOf(p, Track.Source.Microphone);
    const body = cam ? videoEl(cam.track, `lv-video cover${p === lp ? ' mirror' : ''}`) : avatar(p.name, p.identity, 'md');
    const nameRow = h('div', { class: 'lv-tile-name' },
      h('span', { class: 'lv-mic', html: icon(micOn ? 'mic' : 'micOff', 12) }),
      `${p === lp ? 'You' : p.name}${isHostP(p) ? ' · Presenter' : ''}`);
    if (tile.firstChild !== body) tile.replaceChildren(body, nameRow);
    else tile.replaceChild(nameRow, tile.lastChild);
  }
  strip.querySelectorAll('[data-tile]').forEach((t) => { if (!keep.has(t.dataset.tile)) t.remove(); });
  strip.classList.toggle('hidden', keep.size === 0);
  $('#lv-stage').classList.toggle('sharing', !!share);
}

function presentingCard(track) {
  if (S.presentingCard?.sid === track.sid) return S.presentingCard.el;
  const el = h('div', { class: 'lv-presenting' },
    h('div', { class: 'lv-presenting-preview' }, videoEl(track, 'lv-video contain')),
    h('div', { class: 'lv-presenting-text' },
      h('strong', {}, 'You’re presenting to everyone'),
      h('span', { class: 'muted' }, 'Attendees see your shared screen in full quality.'),
      h('button', { class: 'lv-btn danger', onclick: toggleScreen, html: `${icon('screenOff', 18)} Stop presenting` })));
  S.presentingCard = { sid: track.sid, el };
  return el;
}

// Publishing two tracks at the same instant can race SDP negotiation, so
// every local media toggle goes through one queue.
let mediaQueue = Promise.resolve();
function media(fn) {
  const run = mediaQueue.then(fn).catch(mediaError).finally(renderControls);
  mediaQueue = run;
  return run;
}

// ── Controls bar ───────────────────────────────────────────
function ctrl(id, iconName, label, { active, danger, on, off, badge, disabled, title } = {}) {
  return h('button', {
    class: `lv-ctrl${active ? ' active' : ''}${danger ? ' danger' : ''}${off ? ' off' : ''}`,
    id: `ctl-${id}`, title: title || label, 'aria-label': label, 'aria-pressed': active ? 'true' : null, disabled,
    onclick: on,
  }, h('span', { class: 'lv-ctrl-ico', html: icon(iconName, 22) }),
  h('span', { class: 'lv-ctrl-label' }, label),
  badge ? h('span', { class: 'lv-ctrl-badge' }, badge) : null);
}

function renderControls() {
  const bar = $('#lv-controls');
  if (!S.room) return;
  const lp = S.room.localParticipant;
  const s = S.settings;
  const left = h('div', { class: 'lv-ctl-group' });
  const center = h('div', { class: 'lv-ctl-group center' });
  const right = h('div', { class: 'lv-ctl-group right' });

  if (can(lp, SRC.mic)) {
    const on = lp.isMicrophoneEnabled;
    center.append(ctrl('mic', on ? 'mic' : 'micOff', on ? 'Mute' : 'Unmute', { off: !on, on: () => media(() => lp.setMicrophoneEnabled(!on)) }));
  }
  if (can(lp, SRC.camera)) {
    const on = lp.isCameraEnabled;
    center.append(ctrl('cam', on ? 'cam' : 'camOff', on ? 'Stop video' : 'Start video', { off: !on, on: () => media(() => lp.setCameraEnabled(!on)) }));
  }
  if (can(lp, SRC.screen)) {
    const on = lp.isScreenShareEnabled;
    center.append(ctrl('screen', on ? 'screenOff' : 'screen', on ? 'Stop share' : 'Share screen', { active: on, on: toggleScreen }));
  }
  if (!IS_HOST && s.hands) {
    const up = !!handOf(lp);
    center.append(ctrl('hand', 'hand', up ? 'Lower hand' : 'Raise hand', { active: up, on: () => lp.setAttributes({ hand: up ? '' : String(Date.now()) }) }));
  }
  if (s.reactions || IS_HOST) {
    center.append(ctrl('react', 'smile', 'React', { on: (e) => reactionPicker(e.currentTarget), disabled: !IS_HOST && lp.permissions?.canPublishData === false }));
  }
  const hands = everyone().filter((p) => handOf(p)).length;
  center.append(ctrl('chat', 'chat', 'Chat', { active: S.panel === 'chat', on: () => openPanel('chat'), badge: S.unread ? String(Math.min(S.unread, 99)) : null }));
  center.append(ctrl('people', 'users', 'People', { active: S.panel === 'people', on: () => openPanel('people'), badge: IS_HOST && hands ? String(hands) : null }));
  center.append(ctrl('polls', 'poll', 'Polls', { active: S.panel === 'polls', on: () => openPanel('polls'), badge: !IS_HOST && S.poll?.open && !S.myVotes.has(S.poll.id) ? '1' : null }));
  if (IS_HOST) center.append(ctrl('room', 'sliders', 'Controls', { active: S.panel === 'room', on: () => openPanel('room') }));

  left.append(h('button', { class: 'lv-icon-btn', title: 'Audio & video settings', 'aria-label': 'Settings', html: icon('settings'), onclick: deviceSettings }));
  right.append(IS_HOST
    ? h('button', { class: 'lv-btn danger', id: 'ctl-end', onclick: confirmEnd, html: `${icon('phone', 18)}<span class="lv-ctrl-label">End class</span>` })
    : h('button', { class: 'lv-btn danger', id: 'ctl-leave', onclick: () => S.room.disconnect(), html: `${icon('phone', 18)}<span class="lv-ctrl-label">Leave</span>` }));
  bar.replaceChildren(left, center, right);
}

function toggleScreen() {
  return media(shareScreen);
}

async function shareScreen() {
  const lp = S.room.localParticipant;
  const on = lp.isScreenShareEnabled;
  try {
    if (on) {
      await lp.setScreenShareEnabled(false);
    } else {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        toast('Screen sharing isn’t supported on this device. Use Chrome, Edge or Firefox on a computer.', 'error', 6000);
        return;
      }
      const motion = S.shareMotion;
      await lp.setScreenShareEnabled(true, {
        audio: true,
        contentHint: motion ? 'motion' : 'detail',
        resolution: { width: 1920, height: 1080, frameRate: motion ? 30 : 15 },
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      }, {
        screenShareEncoding: motion ? ScreenSharePresets.h1080fps30.encoding : ScreenSharePresets.h1080fps15.encoding,
        screenShareSimulcastLayers: [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps15],
      });
      const pub = lp.getTrackPublication(Track.Source.ScreenShare);
      if (pub?.trackSid) S.seen.set(pub.trackSid, Date.now());
    }
  } catch (err) {
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') mediaError(err);
  }
  renderControls();
  renderStage();
}

function confirmEnd() {
  modal({
    title: 'End the class?',
    body: h('p', {}, 'Everyone will be disconnected and see the closing message. You can also just leave and come back — the room stays open for 5 minutes.'),
    actions: [
      { label: 'Leave (keep room open)', run: () => { S.room.disconnect(); } },
      { label: 'End for everyone', kind: 'danger', run: endForAll },
    ],
  });
}

async function endForAll() {
  const room = S.room.name;
  try {
    await hostOp('end');
    markSupabaseSession(room, false);
  } catch { return false; }
  return true;
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
  const now = Date.now();
  if (now - S.lastReactionAt < 350) return; // keep 200-person rooms calm
  S.lastReactionAt = now;
  showReaction(e, 'You');
  send({ t: 'react', e }, { lossy: true });
}

function showReaction(e, who) {
  const box = $('#lv-reactions');
  if (box.childElementCount > 40) return; // cap on-screen bubbles during reaction storms
  const el = h('div', { class: 'lv-float', style: `--x:${Math.round(Math.random() * 70)}px;--d:${(2.6 + Math.random()).toFixed(2)}s` },
    h('span', { class: 'lv-float-emoji' }, e), who ? h('span', { class: 'lv-float-who' }, who) : null);
  box.append(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Incoming data ──────────────────────────────────────────
function onData(msg, p) {
  const fromHost = isHostP(p);
  switch (msg.t) {
    case 'chat': {
      if (typeof msg.text !== 'string') return;
      const priv = !!msg.priv;
      // Receivers enforce the presenter's chat mode, so a modified client can't spam everyone.
      if (!fromHost && !priv && S.settings.chat !== 'everyone') return;
      if (!fromHost && S.settings.chat === 'off') return;
      addMessage({ id: String(msg.id || uid()), from: p.identity, name: p.name || 'Guest', text: msg.text.slice(0, 1000), ts: Date.now(), priv, host: fromHost });
      break;
    }
    case 'chat-del':
      if (fromHost) removeMessage(msg.id);
      break;
    case 'react':
      if (!REACTIONS.includes(msg.e)) return;
      if (!fromHost && !S.settings.reactions) return;
      showReaction(msg.e, fromHost ? (p.name || 'Presenter') : null);
      break;
    case 'hello':
      if (IS_HOST) syncTo(p.identity);
      break;
    case 'sync':
      if (!fromHost) return;
      S.synced = true;
      for (const m of msg.msgs || []) addMessage({ ...m, quiet: true }, true);
      if (msg.poll) { S.poll = msg.poll; }
      if (msg.results) S.results.set(msg.results.id, msg.results);
      renderChat(); renderPolls(); renderControls();
      break;
    case 'lower-hand':
      if (fromHost && (msg.who === '*' || msg.who === S.identity) && handOf(S.room.localParticipant)) {
        S.room.localParticipant.setAttributes({ hand: '' });
        toast('The presenter lowered your hand.', 'info');
      }
      break;
    case 'poll':
      if (!fromHost || !msg.poll) return;
      if (!S.poll || S.poll.id !== msg.poll.id) toast('📊 New poll from the presenter', 'info');
      S.poll = msg.poll;
      renderPolls(); renderControls();
      if (S.poll.open && !S.myVotes.has(S.poll.id) && window.innerWidth > 900) openPanel('polls');
      break;
    case 'results':
      if (!fromHost) return;
      S.results.set(msg.id, { id: msg.id, counts: msg.counts, total: msg.total });
      renderPolls();
      break;
    case 'vote':
      if (IS_HOST) onVote(p, msg);
      break;
    default:
  }
}

// ── Chat ───────────────────────────────────────────────────
function buildChatPanel() {
  const panel = $('#panel-chat');
  panel.append(
    h('div', { class: 'lv-chat-list', id: 'lv-chat-list', role: 'log', 'aria-live': 'polite' },
      h('div', { class: 'lv-empty', id: 'lv-chat-empty' }, 'Messages will appear here. Say hello 👋')),
    h('div', { class: 'lv-composer', id: 'lv-composer' }));
  renderChatComposer();
}

function renderChatComposer() {
  const box = $('#lv-composer');
  if (!box) return;
  const lp = S.room?.localParticipant;
  const mode = S.settings.chat;
  const blocked = !IS_HOST && lp?.permissions?.canPublishData === false;
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
  if (!IS_HOST && mode === 'off') return;
  const priv = !IS_HOST && mode === 'to-host';
  const msg = { t: 'chat', id: uid(), text: text.slice(0, 500), priv };
  send(msg, { to: priv ? HOST_ID : undefined });
  addMessage({ id: msg.id, from: S.identity, name: S.name, text: msg.text, ts: Date.now(), priv, host: IS_HOST, mine: true });
  input.value = '';
  input.style.height = 'auto';
}

function addMessage(m, deferRender) {
  if (S.messages.some((x) => x.id === m.id)) return;
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
  S.messages.sort((a, b) => a.ts - b.ts);
  list.replaceChildren(...(S.messages.length ? S.messages.map(messageEl) : [h('div', { class: 'lv-empty', id: 'lv-chat-empty' }, 'Messages will appear here. Say hello 👋')]));
  scrollChat(true);
}

function scrollChat(force) {
  const list = $('#lv-chat-list');
  if (list) list.scrollTop = list.scrollHeight;
}

function messageEl(m) {
  const tools = IS_HOST && !m.mine ? h('div', { class: 'lv-msg-tools' },
    h('button', { class: 'lv-icon-btn sm', title: 'Pin as announcement', html: icon('pin', 14), onclick: () => updateSettings({ banner: `${m.name}: ${m.text}` }) }),
    m.from !== HOST_ID ? h('button', { class: 'lv-icon-btn sm', title: 'Mute in chat', html: icon('micOff', 14), onclick: () => hostOp('chat-block', { identity: m.from, blocked: true }).then(() => toast(`${m.name} can no longer chat`, 'info')).catch(() => {}) }) : null,
    !m.priv ? h('button', { class: 'lv-icon-btn sm', title: 'Delete for everyone', html: icon('trash', 14), onclick: () => { removeMessage(m.id); send({ t: 'chat-del', id: m.id }); } }) : null)
    : IS_HOST && m.mine ? h('div', { class: 'lv-msg-tools' },
      h('button', { class: 'lv-icon-btn sm', title: 'Pin as announcement', html: icon('pin', 14), onclick: () => updateSettings({ banner: m.text }) }),
      h('button', { class: 'lv-icon-btn sm', title: 'Delete for everyone', html: icon('trash', 14), onclick: () => { removeMessage(m.id); send({ t: 'chat-del', id: m.id }); } })) : null;
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

// Presenter → late joiner: recent public chat + the current poll.
function syncTo(identity) {
  const pub = S.messages.filter((m) => !m.priv).slice(-60).map(({ id, from, name, text, ts, host }) => ({ id, from, name, text, ts, host }));
  const results = S.poll && (S.poll.showResults || !S.poll.open) ? S.results.get(S.poll.id) : null;
  const chunks = [];
  for (let i = 0; i < pub.length; i += 15) chunks.push(pub.slice(i, i + 15));
  if (!chunks.length) chunks.push([]);
  chunks.forEach((msgs, i) => send({ t: 'sync', msgs, poll: i === 0 ? S.poll : undefined, results: i === 0 ? results : undefined }, { to: identity }));
}

function updateBadges() {
  const chat = $('#badge-chat');
  chat.textContent = S.unread > 99 ? '99+' : S.unread;
  chat.classList.toggle('hidden', !S.unread);
  const hands = everyone().filter((p) => handOf(p)).length;
  const people = $('#badge-people');
  people.textContent = hands;
  people.classList.toggle('hidden', !IS_HOST || !hands);
  const hc = $('#lv-hands-count');
  if (hc) { hc.textContent = hands; $('#lv-hands-pill').classList.toggle('alert', hands > 0); }
}

// ── People ─────────────────────────────────────────────────
function buildPeoplePanel() {
  const panel = $('#panel-people');
  const search = h('input', { class: 'lv-input sm', type: 'search', placeholder: 'Search people', 'aria-label': 'Search people' });
  search.addEventListener('input', () => { S.peopleFilter = search.value.toLowerCase(); renderPeople(); });
  panel.append(
    h('div', { class: 'lv-people-head' }, search,
      IS_HOST ? h('button', { class: 'lv-btn sm', title: 'Lower all hands', onclick: lowerAllHands }, 'Lower all ✋') : null),
    h('div', { class: 'lv-people', id: 'lv-people' }));
}

function renderPeople() {
  updateBadges();
  const box = $('#lv-people');
  if (!box || !S.room || S.panel !== 'people') return;
  const lp = S.room.localParticipant;
  const f = S.peopleFilter;
  const all = everyone().filter((p) => !f || (p.name || '').toLowerCase().includes(f));
  const hands = all.filter((p) => handOf(p)).sort((a, b) => handOf(a) - handOf(b));
  const stage = all.filter((p) => (isHostP(p) || onStage(p)) && !handOf(p));
  const rest = all.filter((p) => !isHostP(p) && !onStage(p) && !handOf(p)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const sections = [];
  if (hands.length && (IS_HOST || S.settings.showPeople)) sections.push(section(`Raised hands · ${hands.length}`, hands));
  sections.push(section(`Presenters · ${stage.length}`, stage));
  if (IS_HOST || S.settings.showPeople) {
    sections.push(section(`Attendees · ${rest.length}`, rest.slice(0, 400)));
  } else {
    sections.push(h('div', { class: 'lv-people-note' }, `${viewerCount()} people are in this class. The presenter has hidden the attendee list.`),
      handOf(lp) ? section('Your hand is raised', [lp]) : null);
  }
  box.replaceChildren(...sections.filter(Boolean));

  function section(title, list) {
    return h('div', { class: 'lv-people-sec' }, h('div', { class: 'lv-people-title' }, title),
      list.length ? list.map((p) => personRow(p, lp)) : h('div', { class: 'lv-people-none' }, 'No one yet'));
  }
}

function personRow(p, lp) {
  const badges = [];
  if (handOf(p)) badges.push(h('span', { class: 'lv-hand-badge', title: 'Hand raised' }, '✋'));
  if (pubOf(p, Track.Source.ScreenShare)) badges.push(h('span', { class: 'lv-state', title: 'Sharing screen', html: icon('screen', 14) }));
  if (pubOf(p, Track.Source.Camera)) badges.push(h('span', { class: 'lv-state', title: 'Camera on', html: icon('cam', 14) }));
  if (can(p, SRC.mic) && !isHostP(p) || isHostP(p)) badges.push(h('span', { class: `lv-state${pubOf(p, Track.Source.Microphone) ? ' on' : ''}`, title: pubOf(p, Track.Source.Microphone) ? 'Mic on' : 'Mic off', html: icon(pubOf(p, Track.Source.Microphone) ? 'mic' : 'micOff', 14) }));
  if (p.permissions && p.permissions.canPublishData === false) badges.push(h('span', { class: 'lv-state warn', title: 'Muted in chat', html: icon('chat', 14) }));
  return h('div', { class: 'lv-person', 'data-speaker': p.identity },
    avatar(p.name, p.identity, 'sm'),
    h('div', { class: 'lv-person-name' }, p === lp ? `${p.name} (you)` : p.name || p.identity,
      isHostP(p) ? h('span', { class: 'lv-tag' }, 'Presenter') : onStage(p) ? h('span', { class: 'lv-tag alt' }, 'On stage') : null),
    h('div', { class: 'lv-person-badges' }, badges),
    IS_HOST && !isHostP(p) ? h('button', { class: 'lv-icon-btn sm', 'aria-label': `Actions for ${p.name}`, title: 'Actions', html: icon('more', 18), onclick: (e) => { e.stopPropagation(); personMenu(p, e.currentTarget); } }) : null);
}

function personMenu(p, anchor) {
  closePopovers();
  const has = (src) => can(p, src);
  const current = new Set(['screen', 'mic', 'camera'].filter((k) => has(SRC[k])));
  const permit = async (sources, msg) => {
    closePopovers();
    await hostOp('permit', { identity: p.identity, sources: [...sources] }).catch(() => {});
    if (msg) toast(msg, 'success');
    if (handOf(p) && sources.size) send({ t: 'lower-hand', who: p.identity });
  };
  const item = (label, fn, cls = '') => h('button', { class: `lv-menu-item ${cls}`, role: 'menuitem', onclick: fn }, label);
  const toggled = (k) => { const s = new Set(current); s.has(k) ? s.delete(k) : s.add(k); return s; };
  const items = [
    h('div', { class: 'lv-menu-title' }, p.name),
    item(has(SRC.screen) ? '✓ Can share screen' : 'Allow screen share', () => permit(toggled('screen'), has(SRC.screen) ? null : `${p.name} can now share their screen`)),
    item(has(SRC.mic) ? '✓ Can speak (mic)' : 'Allow to speak (mic)', () => permit(toggled('mic'), has(SRC.mic) ? null : `${p.name} can now unmute`)),
    item(has(SRC.camera) ? '✓ Can use camera' : 'Allow camera', () => permit(toggled('camera'))),
    item('Make co-presenter (all)', () => permit(new Set(['screen', 'mic', 'camera']), `${p.name} is now a co-presenter`)),
    current.size ? item('Take off stage', () => permit(new Set(), `${p.name} was taken off stage`)) : null,
    h('div', { class: 'lv-menu-sep' }),
    pubOf(p, Track.Source.Microphone) ? item('Mute microphone', () => { closePopovers(); hostOp('mute', { identity: p.identity, sources: ['mic'] }).catch(() => {}); }) : null,
    pubOf(p, Track.Source.ScreenShare) ? item('Stop their screen share', () => { closePopovers(); hostOp('mute', { identity: p.identity, sources: ['screen', 'screenAudio'] }).catch(() => {}); }) : null,
    handOf(p) ? item('Lower hand', () => { closePopovers(); send({ t: 'lower-hand', who: p.identity }); }) : null,
    p.permissions?.canPublishData === false
      ? item('Allow chat again', () => { closePopovers(); hostOp('chat-block', { identity: p.identity, blocked: false }).catch(() => {}); })
      : item('Mute in chat', () => { closePopovers(); hostOp('chat-block', { identity: p.identity, blocked: true }).catch(() => {}); }),
    item('Remove from class', () => {
      closePopovers();
      modal({ title: `Remove ${p.name}?`, body: h('p', {}, 'They will be disconnected. Lock the room to stop anyone rejoining.'),
        actions: [{ label: 'Cancel' }, { label: 'Remove', kind: 'danger', run: () => hostOp('remove', { identity: p.identity }).catch(() => false) }] });
    }, 'danger'),
  ];
  const pop = h('div', { class: 'lv-popover lv-menu', role: 'menu', onclick: (e) => e.stopPropagation() }, items.filter(Boolean));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8);
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener('click', closePopovers, { once: true }), 0);
}

function lowerAllHands() {
  send({ t: 'lower-hand', who: '*' });
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
      send({ t: 'poll', poll });
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
          send({ t: 'vote', id: poll.id, c: i }, { to: HOST_ID });
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
}

function broadcastResults(poll) {
  const r = S.results.get(poll.id);
  if (r) send({ t: 'results', id: poll.id, counts: r.counts, total: r.total });
}

function closePoll() {
  if (!S.poll) return;
  S.poll.open = false;
  send({ t: 'poll', poll: S.poll });
  broadcastResults(S.poll);
  renderPolls();
}

// ── Presenter controls panel ───────────────────────────────
function buildRoomPanel() {
  const panel = $('#panel-room');
  const seg = (name, options) => h('div', { class: 'lv-seg', role: 'radiogroup', 'data-setting': name },
    options.map(([value, label]) => h('button', { role: 'radio', 'data-value': value, onclick: () => updateSettings({ [name]: value }) }, label)));
  const sw = (name, label, hint) => h('label', { class: 'lv-switch-row' },
    h('span', {}, h('span', { class: 'lv-switch-label' }, label), hint ? h('span', { class: 'lv-switch-hint' }, hint) : null),
    h('input', { type: 'checkbox', class: 'lv-switch', 'data-setting': name, onchange: (e) => updateSettings({ [name]: e.target.checked }) }));

  const title = h('input', { class: 'lv-input sm', id: 'rc-title', maxlength: 120, placeholder: 'Session title' });
  const banner = h('textarea', { class: 'lv-input sm', id: 'rc-banner', rows: 2, maxlength: 280, placeholder: 'e.g. Download the workbook: https://…' });
  const invite = new URL('index.html', location.href).href;

  panel.append(h('div', { class: 'lv-room-panel' },
    group('Session',
      h('div', { class: 'lv-inline' }, title, h('button', { class: 'lv-btn sm', onclick: () => updateSettings({ title: title.value.trim() }) }, 'Save')),
      h('div', { class: 'lv-inline' },
        h('input', { class: 'lv-input sm', readonly: true, value: invite, 'aria-label': 'Invite link' }),
        h('button', { class: 'lv-btn sm', title: 'Copy invite link', html: icon('copy', 16), onclick: () => navigator.clipboard?.writeText(invite).then(() => toast('Invite link copied', 'success')) }))),
    group('Pinned announcement',
      banner,
      h('div', { class: 'lv-inline end' },
        h('button', { class: 'lv-btn sm', onclick: () => { banner.value = ''; updateSettings({ banner: '' }); } }, 'Clear'),
        h('button', { class: 'lv-btn primary sm', onclick: () => updateSettings({ banner: banner.value.trim() }) }, 'Pin'))),
    group('Chat', seg('chat', [['everyone', 'Everyone'], ['to-host', 'Questions to me'], ['off', 'Off']]),
      h('button', { class: 'lv-link-btn', onclick: exportChat, html: `${icon('download', 14)} Download chat transcript` })),
    group('Participation',
      sw('reactions', 'Emoji reactions', 'Floating reactions over the stage'),
      sw('hands', 'Raise hand', 'Attendees can ask to speak'),
      sw('showPeople', 'Show attendee list', 'Otherwise attendees only see the count'),
      sw('locked', 'Lock room', 'No new attendees can join')),
    group('Stage',
      h('div', { class: 'lv-grid2' },
        h('button', { class: 'lv-btn sm', onclick: () => hostOp('mute-all').then(() => toast('Everyone muted', 'info')).catch(() => {}) }, 'Mute everyone'),
        h('button', { class: 'lv-btn sm', onclick: lowerAllHands }, 'Lower all hands'),
        h('button', { class: 'lv-btn sm', onclick: () => hostOp('revoke-all').then(() => toast('Everyone is off stage', 'info')).catch(() => {}) }, 'Clear the stage'),
        h('button', { class: 'lv-btn sm', onclick: () => openPanel('people') }, 'Manage people'))),
    group('Session end', h('button', { class: 'lv-btn danger', onclick: confirmEnd }, 'End class for everyone'))));
  syncRoomPanel();

  function group(label, ...kids) {
    return h('div', { class: 'lv-group' }, h('div', { class: 'lv-people-title' }, label), ...kids);
  }
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
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `chat-${S.room?.name || 'class'}.txt` });
  document.body.append(a); a.click(); a.remove();
}

// ── Device settings ────────────────────────────────────────
async function deviceSettings() {
  const lp = S.room.localParticipant;
  const make = async (kind, label) => {
    let devices = [];
    try { devices = await Room.getLocalDevices(kind, false); } catch { /* permission not granted yet */ }
    if (!devices.length) return null;
    const active = S.room.getActiveDevice(kind);
    const sel = h('select', { class: 'lv-input sm', onchange: (e) => S.room.switchActiveDevice(kind, e.target.value).catch(mediaError) },
      devices.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === active }, d.label || `${label} ${d.deviceId.slice(0, 4)}`)));
    return h('label', { class: 'lv-label' }, label, sel);
  };
  const parts = [];
  if (can(lp, SRC.mic)) parts.push(await make('audioinput', 'Microphone'));
  if (can(lp, SRC.camera)) parts.push(await make('videoinput', 'Camera'));
  parts.push(await make('audiooutput', 'Speaker'));
  if (can(lp, SRC.screen)) {
    const motion = h('input', { type: 'checkbox', checked: S.shareMotion, onchange: (e) => { S.shareMotion = e.target.checked; } });
    parts.push(h('label', { class: 'lv-check' }, motion, 'Optimise screen share for video (30 fps) instead of text & slides'));
  }
  const body = h('div', { class: 'lv-form' }, parts.filter(Boolean).length ? parts.filter(Boolean) : h('p', { class: 'muted' }, 'No devices to configure.'));
  modal({ title: 'Audio & video', body, actions: [{ label: 'Done', kind: 'primary' }] });
}

// ── Render all ─────────────────────────────────────────────
function renderAll() {
  renderStage();
  renderControls();
  renderPeople();
  renderPolls();
  updateCount();
  tickTimer();
}

window.addEventListener('resize', () => schedule('resize', () => {
  if (window.innerWidth <= 900 && S.panel && $('#lv-app').dataset.state !== 'live') openPanel(null);
}, 200));
window.addEventListener('beforeunload', () => { S.ending = true; S.room?.disconnect(); });

shell();
showPrejoin();

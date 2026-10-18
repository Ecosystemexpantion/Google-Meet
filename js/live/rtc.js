// ─── Cloudflare Realtime SFU transport ────────────────────
// Media: partytracks (Cloudflare's own client, vendored) pushes/pulls tracks.
// Data:  one extra PeerConnection per person carries SFU DataChannels:
//        presenter → everyone on "room", each attendee → presenter on "up".
// All SFU calls go through the Supabase Edge Function proxy, which holds the
// Cloudflare secret. It hands back a signature for every session we create;
// this module attaches it to later calls on that session.
import { PartyTracks, BehaviorSubject, of, setLogLevel } from '../vendor/partytracks.mjs?v=__BUILD__';
import { endpoint } from './api.js?v=__BUILD__';

const SFU = () => `${endpoint()}/sfu`;
const sigs = new Map();
let authToken = null;

setLogLevel?.('warn');

export function setAuthToken(token) {
  authToken = token;
}

// partytracks calls the global fetch; add our headers to proxy calls.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith(SFU())) return nativeFetch(input, init);
  if (url === `${SFU()}/generate-ice-servers`) return new Response(await cachedIce(), { headers: { 'Content-Type': 'application/json' } });
  const headers = new Headers(init.headers);
  const m = /\/sessions\/([A-Za-z0-9_-]+)\//.exec(url);
  if (/\/sessions\/new/.test(url)) headers.set('x-lv-token', authToken || '');
  else if (m && sigs.has(m[1])) headers.set('x-lv-sig', sigs.get(m[1]));
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await nativeFetch(input, { ...init, headers });
  if (/\/sessions\/new/.test(url)) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.sessionId && body.sig) sigs.set(body.sessionId, body.sig);
  }
  return res;
};

// ICE/TURN servers are fetched once and reused for 10 minutes (credentials
// last a day): each new connection would otherwise cost an extra round trip.
let icePromise = null;
let iceAt = 0;
function cachedIce() {
  if (!icePromise || Date.now() - iceAt > 600000) {
    iceAt = Date.now();
    icePromise = nativeFetch(`${SFU()}/generate-ice-servers`).then((r) => {
      if (!r.ok) throw new Error(`ice ${r.status}`);
      return r.text();
    }).catch((e) => { icePromise = null; throw e; });
  }
  return icePromise;
}

async function sfu(path, method, body) {
  const res = await window.fetch(`${SFU()}/${path}`, { method, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errorCode) throw new Error(data.errorDescription || data.message || data.error || `SFU ${res.status}`);
  return data;
}

// ── Media ──────────────────────────────────────────────────
export class Media {
  constructor() {
    this.pt = new PartyTracks({ prefix: SFU() });
    this.state$ = this.pt.peerConnectionState$;
    this.pc = null; // for reading stats and closing; set once the session exists
    this.pcSub = null;
  }

  /** Keep a handle on the connection (call after the first push/pull starts it). */
  watchPc() {
    this.pcSub ||= this.pt.peerConnection$.subscribe((pc) => { this.pc = pc; });
  }

  /**
   * Push a local track. onMeta fires with { sessionId, trackName, location }
   * once it can be pulled, and again if the connection had to be rebuilt.
   */
  push(track, { encodings, onMeta } = {}) {
    const source = new BehaviorSubject(track);
    const sub = this.pt.push(source, encodings ? { sendEncodings$: of(encodings) } : {})
      .subscribe({ next: (meta) => onMeta?.({ sessionId: meta.sessionId, trackName: meta.trackName, location: 'remote' }), error: (e) => console.warn('push', e) });
    return {
      replace: (t) => source.next(t),
      stop: () => sub.unsubscribe(),
    };
  }

  /** Close this connection for good. */
  close() {
    this.pcSub?.unsubscribe();
    try { this.pc?.close(); } catch { /* already closed */ }
  }
}

/**
 * Receive one remote track on its own connection (its own SFU session).
 * Keeping every received track separate means opening or closing one can
 * never break another, and a connection that fails or goes quiet is simply
 * replaced: restart() (or any error) tears it down and pulls again on a
 * fresh one, backing off 1.5 s, 3 s, … up to 10 s.
 */
export function pullTrack(meta, { rid, onTrack } = {}) {
  const rid$ = new BehaviorSubject(rid);
  let media = null;
  let sub = null;
  let stopped = false;
  let tries = 0;
  let timer = null;
  const teardown = () => { sub?.unsubscribe(); sub = null; media?.close(); media = null; };
  const start = () => {
    if (stopped) return;
    media = new Media();
    sub = media.pt.pull(of({ sessionId: meta.sessionId, trackName: meta.trackName, location: 'remote' }), rid ? { simulcast: { preferredRid$: rid$ } } : {})
      .subscribe({
        next: (t) => { tries = 0; onTrack?.(t); },
        error: (e) => { console.warn('pull', e); restart(); },
      });
    media.watchPc();
  };
  const restart = () => {
    if (stopped) return;
    teardown();
    clearTimeout(timer);
    timer = setTimeout(start, Math.min(1500 * ++tries, 10000));
  };
  start();
  return {
    setRid: (r) => { if (rid) rid$.next(r); },
    restart,
    stop: () => { stopped = true; clearTimeout(timer); teardown(); },
    get pc() { return media?.pc || null; },
  };
}

/**
 * Send one local track (microphone, screen…) on its own connection, opened
 * only when sending starts: Cloudflare drops a session that sits unused, so a
 * connection opened at join time and first used minutes later is refused.
 * On any error it is redone on a fresh connection; onMeta then reports the
 * new track so everyone re-subscribes.
 */
export function pushTrack(track, { encodings, onMeta } = {}) {
  const source = new BehaviorSubject(track);
  let media = null;
  let sub = null;
  let stopped = false;
  let tries = 0;
  let timer = null;
  const teardown = () => { sub?.unsubscribe(); sub = null; media?.close(); media = null; };
  const start = () => {
    if (stopped) return;
    media = new Media();
    sub = media.pt.push(source, encodings ? { sendEncodings$: of(encodings) } : {})
      .subscribe({
        next: (meta) => { tries = 0; onMeta?.({ sessionId: meta.sessionId, trackName: meta.trackName, location: 'remote' }); },
        error: (e) => { console.warn('push', e); restart(); },
      });
    media.watchPc();
  };
  const restart = () => {
    if (stopped) return;
    teardown();
    clearTimeout(timer);
    timer = setTimeout(start, Math.min(1500 * ++tries, 10000));
  };
  start();
  return {
    replace: (t) => source.next(t),
    restart,
    stop: () => { stopped = true; clearTimeout(timer); teardown(); },
    get pc() { return media?.pc || null; },
  };
}

// ── Data ───────────────────────────────────────────────────
export class DataLink extends EventTarget {
  constructor() {
    super();
    this.channels = new Map();
    this.sessionId = null;
    this.pc = null;
    this.queue = Promise.resolve();
  }

  async open(iceServers) {
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.addEventListener('connectionstatechange', () => {
      this.dispatchEvent(new CustomEvent('state', { detail: pc.connectionState }));
    });
    const { sessionId } = await sfu('sessions/new', 'POST');
    this.sessionId = sessionId;
    const est = await sfu(`sessions/${sessionId}/datachannels/establish`, 'POST', { dataChannel: { location: 'remote', dataChannelName: 'server-events' } });
    await pc.setRemoteDescription(est.sessionDescription);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sfu(`sessions/${sessionId}/renegotiate`, 'PUT', { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } });
    await waitConnected(pc, 20000);
    return sessionId;
  }

  /** specs: [{ location:'local'|'remote', dataChannelName, sessionId? }] → RTCDataChannel[] (null on error) */
  add(specs) {
    const run = this.queue.then(async () => {
      const res = await sfu(`sessions/${this.sessionId}/datachannels/new`, 'POST', { dataChannels: specs.map((s) => ({ ordered: true, ...s })) });
      return res.dataChannels.map((d, i) => {
        if (d.errorCode || typeof d.id !== 'number') return null;
        const dc = this.pc.createDataChannel(specs[i].dataChannelName, { negotiated: true, id: d.id, ordered: true });
        dc.sfuId = d.id;
        return dc;
      });
    });
    this.queue = run.catch(() => {});
    return run;
  }

  close(ids) {
    if (!ids.length) return Promise.resolve();
    const run = this.queue.then(() => sfu(`sessions/${this.sessionId}/datachannels/close`, 'PUT', { dataChannels: ids.map((id) => ({ id })) }).catch(() => {}));
    this.queue = run;
    return run;
  }

  shutdown() {
    try { this.pc?.close(); } catch { /* already closed */ }
  }
}

export async function iceServers() {
  try {
    const res = await window.fetch(`${SFU()}/generate-ice-servers`);
    const body = await res.json();
    return body.iceServers || [];
  } catch {
    return [{ urls: 'stun:stun.cloudflare.com:3478' }];
  }
}

function waitConnected(pc, ms) {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pc.removeEventListener('connectionstatechange', on); reject(new Error('Could not connect (timed out). Check your internet connection.')); }, ms);
    const on = () => {
      if (pc.connectionState === 'connected') { clearTimeout(t); pc.removeEventListener('connectionstatechange', on); resolve(); }
      if (pc.connectionState === 'failed') { clearTimeout(t); pc.removeEventListener('connectionstatechange', on); reject(new Error('Connection failed. Your network may be blocking live video.')); }
    };
    pc.addEventListener('connectionstatechange', on);
  });
}

export function whenOpen(dc, ms = 15000) {
  if (dc.readyState === 'open') return Promise.resolve(dc);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('data channel timeout')), ms);
    dc.addEventListener('open', () => { clearTimeout(t); resolve(dc); }, { once: true });
  });
}

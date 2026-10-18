// ─── Cloudflare Realtime SFU transport ────────────────────
// Media: partytracks (Cloudflare's own client, vendored) pushes/pulls tracks.
// Data:  one extra PeerConnection per person carries SFU DataChannels:
//        presenter → everyone on "room", each attendee → presenter on "up".
// All SFU calls go through the Supabase Edge Function proxy, which holds the
// Cloudflare secret. It hands back a signature for every session we create;
// this module attaches it to later calls on that session.
import { PartyTracks, BehaviorSubject, of, setLogLevel } from '../vendor/partytracks.mjs?v=d255b885';
import { endpoint } from './api.js?v=d255b885';

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

  /** Pull a remote track; onTrack receives the MediaStreamTrack. */
  pull(meta, { rid, onTrack } = {}) {
    const rid$ = new BehaviorSubject(rid);
    const sub = this.pt.pull(of({ sessionId: meta.sessionId, trackName: meta.trackName, location: 'remote' }), rid ? { simulcast: { preferredRid$: rid$ } } : {})
      .subscribe({ next: (t) => onTrack?.(t), error: (e) => console.warn('pull', e) });
    return {
      setRid: (r) => { if (rid) rid$.next(r); },
      stop: () => sub.unsubscribe(),
    };
  }
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

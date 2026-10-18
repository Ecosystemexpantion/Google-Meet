// ─── Classroom API (Supabase Edge Function) ────────────────
// The only server-side piece of the live classroom. It
//   1. proxies the browser's WebRTC signalling to Cloudflare Realtime SFU,
//      adding the secret app token (browsers never see it), and
//   2. keeps a tiny registry in Postgres: is the class open, where is the
//      presenter's data channel, and which attendees have joined.
//
// Media and all live messages (chat, reactions, polls, hands…) flow through
// Cloudflare; this function only handles a few calls per attendee.
//
// Runtime-agnostic (Deno on Supabase, Node for local tests): web-standard
// fetch/Request/Response/crypto only.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-lv-token, x-lv-sig',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Expose-Headers': 'x-lv-sig',
};

const SFU_OPS = /^sessions\/([A-Za-z0-9_-]{8,128})\/(tracks\/new|tracks\/close|tracks\/update|renegotiate|datachannels\/establish|datachannels\/new|datachannels\/close)$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
}

function clean(str, max) {
  return String(str ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function roomName(str) {
  const name = clean(str, 64);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(name)) throw new HttpError(400, 'bad_room');
  return name;
}

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * @param {object} opts
 * @param {(key: string) => string | undefined} opts.env
 * @param {object} opts.store  see supabaseStore() / memoryStore()
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createHandler({ env, store, fetchImpl = (...a) => fetch(...a) }) {
  // Settings come from Edge Function secrets, falling back to Supabase Vault
  // (secrets named lv_<lowercase name>, read once per worker via the store).
  let cfg = null;
  let cfgPromise = null;
  const loadConfig = () => (cfgPromise ||= (async () => {
    const vault = store.loadConfig ? await store.loadConfig().catch((e) => { console.error('vault', e); return {}; }) : {};
    const get = (k) => env(k) || vault[`lv_${k.toLowerCase()}`];
    cfg = {
      appId: get('CF_SFU_APP_ID'),
      appToken: get('CF_SFU_APP_TOKEN'),
      turnKeyId: get('CF_TURN_KEY_ID'),
      turnToken: get('CF_TURN_KEY_TOKEN'),
      sfuBase: get('CF_SFU_API_BASE') || 'https://rtc.live.cloudflare.com/v1',
      hostPassword: get('HOST_PASSWORD'),
      maxAttendees: Number(get('MAX_PARTICIPANTS') || 300),
    };
    if (!cfg.appId || !cfg.appToken) cfgPromise = null; // retry on the next request
  })());
  let keyPromise = null;
  const key = () => (keyPromise ||= crypto.subtle.importKey('raw', new TextEncoder().encode(`lv:${cfg.appToken}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));

  async function mac(text) {
    return b64u(await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(text)));
  }
  async function sign(payload, ttlSec) {
    const body = b64u(new TextEncoder().encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
    return `${body}.${await mac(body)}`;
  }
  async function verify(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !safeEqual(sig, await mac(body))) throw new HttpError(401, 'bad_token');
    const data = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    if (data.exp < Date.now() / 1000) throw new HttpError(401, 'expired');
    return data;
  }
  async function requireHost(token) {
    const t = await verify(token);
    if (t.role !== 'host') throw new HttpError(403, 'not_host');
    return t;
  }
  function checkPassword(password) {
    if (!cfg.hostPassword) throw new HttpError(500, 'host_password_not_configured');
    if (!safeEqual(password ?? '', cfg.hostPassword)) throw new HttpError(401, 'bad_password');
  }

  // ── Cloudflare proxy ────────────────────────────────────
  async function proxy(req, path) {
    if (path === 'generate-ice-servers') {
      if (cfg.turnKeyId && cfg.turnToken) {
        const res = await fetchImpl(`${cfg.sfuBase}/turn/keys/${cfg.turnKeyId}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.turnToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        });
        if (res.ok) return json(200, await res.json());
      }
      return json(200, { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] }] });
    }

    const upstream = (p, init) => fetchImpl(`${cfg.sfuBase}/apps/${cfg.appId}/${p}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.appToken}`, 'Content-Type': 'application/json' },
    });

    if (path === 'sessions/new') {
      // Only people who joined through this API may open SFU sessions.
      await verify(req.headers.get('x-lv-token'));
      const res = await upstream('sessions/new', { method: 'POST', body: await req.text() || undefined });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.sessionId) return json(res.status || 502, body);
      // Every later call on this session must carry this signature, so
      // nobody else can close or change someone's tracks.
      return json(res.status, { ...body, sig: await mac(`s:${body.sessionId}`) });
    }

    const m = SFU_OPS.exec(path);
    if (!m) throw new HttpError(404, 'not_found');
    if (!safeEqual(req.headers.get('x-lv-sig') || '', await mac(`s:${m[1]}`))) throw new HttpError(403, 'bad_session_sig');
    const res = await upstream(path, { method: req.method, body: req.method === 'GET' ? undefined : await req.text() });
    return new Response(await res.text(), { status: res.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // ── Class registry ──────────────────────────────────────
  async function action(body) {
    switch (body.action) {
      case 'host-login':
        checkPassword(body.password);
        return { ok: true };

      case 'host-open': {
        checkPassword(body.password);
        const room = roomName(body.room);
        const prev = await store.getRoom(room);
        const reopen = prev?.open;
        const row = await store.saveRoom(room, {
          open: true,
          locked: reopen ? !!prev.locked : false,
          title: clean(body.title, 120) || prev?.title || '',
          started_at: reopen ? prev.started_at : new Date().toISOString(),
          banned: reopen ? prev.banned || [] : [],
        });
        if (!reopen) await store.clearAttendees(room);
        const token = await sign({ role: 'host', room, id: 'host', name: clean(body.name, 40) || 'Presenter' }, 12 * 3600);
        return { token, room: publicRoom(row) };
      }

      case 'host-ready': {
        const t = await requireHost(body.token);
        await store.saveRoom(t.room, { host_data_session: clean(body.dataSession, 128) });
        return { ok: true };
      }

      case 'host-update': {
        const t = await requireHost(body.token);
        const patch = {};
        if ('locked' in body) patch.locked = !!body.locked;
        if ('title' in body) patch.title = clean(body.title, 120);
        if ('open' in body) patch.open = !!body.open;
        if (body.ban) {
          const room = await store.getRoom(t.room);
          patch.banned = [...new Set([...(room?.banned || []), clean(body.ban, 64)])].slice(-500);
        }
        return { room: publicRoom(await store.saveRoom(t.room, patch)) };
      }

      case 'host-poll': {
        const t = await requireHost(body.token);
        const [attendees, room] = await Promise.all([store.listAttendees(t.room, Number(body.after) || 0), store.getRoom(t.room)]);
        const cast = room?.cast_info;
        // age is measured on the server so phone/computer clock drift doesn't matter
        return { attendees, cast: cast ? { ...cast, age: Date.now() - cast.at } : null };
      }

      // EEM26 Cast (Android app) heartbeat: which tracks it's publishing.
      // Replies stop:true once the presenter pressed "Stop presenting".
      case 'cast-start': {
        const t = await requireHost(body.token);
        const screen = trackMeta(body.screen);
        if (!screen) throw new HttpError(400, 'bad_meta');
        const room = await store.getRoom(t.room);
        if (room?.cast_info?.stop && room.cast_info.screen?.sessionId === screen.sessionId) {
          await store.saveRoom(t.room, { cast_info: null });
          return { stop: true };
        }
        await store.saveRoom(t.room, { cast_info: { screen, mic: trackMeta(body.mic), at: Date.now() } });
        return { stop: false };
      }

      // From the app: it stopped. From the presenter page: ask the app to stop.
      case 'cast-stop': {
        const t = await requireHost(body.token);
        const room = await store.getRoom(t.room);
        await store.saveRoom(t.room, { cast_info: body.fromApp || !room?.cast_info ? null : { ...room.cast_info, stop: true } });
        return { ok: true };
      }

      case 'room-info': {
        const room = await store.getRoom(roomName(body.room));
        return { room: room ? publicRoom(room) : null };
      }

      case 'join': {
        const room = roomName(body.room);
        const name = clean(body.name, 40);
        const id = clean(body.id, 48).replace(/[^A-Za-z0-9-]/g, '');
        if (name.length < 2) throw new HttpError(400, 'bad_name');
        if (id.length < 8) throw new HttpError(400, 'bad_id');
        const info = await store.getRoom(room);
        if (!info?.open || !info.host_data_session) throw new HttpError(409, 'not_started', 'The presenter has not opened the room yet.');
        const identity = `guest_${id}`;
        if ((info.banned || []).includes(identity)) throw new HttpError(403, 'banned', 'The presenter removed you from this class.');
        if (info.locked) throw new HttpError(423, 'locked', 'The presenter has locked the room.');
        if (await store.countAttendees(room) >= cfg.maxAttendees) throw new HttpError(429, 'full', 'This class is full.');
        const token = await sign({ role: 'guest', room, id: identity, name }, 10 * 3600);
        return { token, identity, room: publicRoom(info) };
      }

      case 'register': {
        const t = await verify(body.token);
        if (t.role !== 'guest') throw new HttpError(403, 'not_guest');
        const row = await store.addAttendee({ room: t.room, identity: t.id, name: t.name, data_session: clean(body.dataSession, 128) });
        return { ok: true, seq: row.id };
      }

      default:
        throw new HttpError(400, 'bad_action');
    }
  }

  function trackMeta(m) {
    if (!m || typeof m !== 'object') return null;
    const sessionId = clean(m.sessionId, 128);
    const trackName = clean(m.trackName, 80);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId) || !/^[A-Za-z0-9_.:-]{1,80}$/.test(trackName)) return null;
    return { sessionId, trackName };
  }

  function publicRoom(r) {
    return { name: r.name, open: !!r.open, locked: !!r.locked, title: r.title || '', startedAt: r.started_at ? Date.parse(r.started_at) : null, hostDataSession: r.host_data_session || null };
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    await loadConfig();
    if (!cfg.appId || !cfg.appToken) {
      return json(500, { error: 'not_configured', message: 'Set CF_SFU_APP_ID and CF_SFU_APP_TOKEN secrets.' });
    }
    try {
      const path = new URL(req.url).pathname;
      const at = path.indexOf('/sfu/');
      if (at !== -1) return await proxy(req, path.slice(at + 5));
      if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      return json(200, await action(await req.json().catch(() => ({}))));
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message });
      console.error(err);
      return json(502, { error: 'server_error', message: err?.message || String(err) });
    }
  };
}

// ── Stores ─────────────────────────────────────────────────
// Postgres via PostgREST with the service-role key (tables have RLS on and no
// public policies, so the anon key can't read or write them).
export function supabaseStore({ url, serviceKey, fetchImpl = (...a) => fetch(...a) }) {
  const rest = async (path, init = {}) => {
    const res = await fetchImpl(`${url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    async loadConfig() {
      return rest('rpc/lv_config', { method: 'POST', body: '{}' });
    },
    async getRoom(name) {
      const rows = await rest(`lv_rooms?name=eq.${encodeURIComponent(name)}&select=*`);
      return rows[0] || null;
    },
    async saveRoom(name, patch) {
      const rows = await rest('lv_rooms?on_conflict=name', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ name, ...patch, updated_at: new Date().toISOString() }),
      });
      return rows[0];
    },
    async clearAttendees(room) {
      await rest(`lv_attendees?room=eq.${encodeURIComponent(room)}`, { method: 'DELETE' });
    },
    async addAttendee(row) {
      const rows = await rest('lv_attendees', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
      return rows[0];
    },
    async listAttendees(room, after) {
      return rest(`lv_attendees?room=eq.${encodeURIComponent(room)}&id=gt.${after}&order=id.asc&limit=500&select=id,identity,name,data_session`);
    },
    async countAttendees(room) {
      // distinct people who joined in the last 3 hours
      const since = new Date(Date.now() - 3 * 3600e3).toISOString();
      const rows = await rest(`lv_attendees?room=eq.${encodeURIComponent(room)}&created_at=gte.${since}&select=identity`);
      return new Set(rows.map((r) => r.identity)).size;
    },
  };
}

export function memoryStore() {
  const rooms = new Map();
  let attendees = [];
  let seq = 0;
  return {
    async getRoom(name) { return rooms.get(name) || null; },
    async saveRoom(name, patch) { const r = { ...(rooms.get(name) || { name }), ...patch }; rooms.set(name, r); return r; },
    async clearAttendees(room) { attendees = attendees.filter((a) => a.room !== room); },
    async addAttendee(row) { const r = { ...row, id: ++seq, created_at: new Date().toISOString() }; attendees.push(r); return r; },
    async listAttendees(room, after) { return attendees.filter((a) => a.room === room && a.id > after).slice(0, 500); },
    async countAttendees(room) { return new Set(attendees.filter((a) => a.room === room).map((a) => a.identity)).size; },
  };
}

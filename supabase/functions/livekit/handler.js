// ─── LiveKit token + moderation API ────────────────────────
// Shared by the Supabase Edge Function (index.ts, Deno) and the local
// dev server (dev/server.mjs, Node). Keep it runtime-agnostic: only
// web-standard APIs (Request/Response/crypto) plus livekit-server-sdk.
//
// Every request is POST JSON: { action, ...params }
//   join        → attendee token (room must already be opened by the host)
//   host-login  → checks the host password, returns nothing but 200/401
//   host-join   → creates/opens the room, returns the presenter token
//   host        → presenter-only moderation, authenticated with the
//                 presenter's own LiveKit token (roomAdmin grant)
import {
  AccessToken,
  RoomServiceClient,
  TokenVerifier,
  TrackSource,
} from 'livekit-server-sdk';

export const HOST_IDENTITY = 'host';

export const DEFAULT_SETTINGS = {
  chat: 'everyone',      // 'everyone' | 'to-host' | 'off'
  reactions: true,
  hands: true,
  locked: false,
  showPeople: false,     // can attendees see the full attendee list?
  banner: '',            // pinned announcement shown above the stage
  title: '',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALL_SOURCES = [
  TrackSource.CAMERA,
  TrackSource.MICROPHONE,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function clean(str, max) {
  return String(str ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function roomName(str) {
  const name = clean(str, 64);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(name)) throw new HttpError(400, 'bad_room');
  return name;
}

// Constant-time string compare so the password can't be timed.
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function parseSettings(metadata) {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(metadata || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

/**
 * @param {(key: string) => string | undefined} env
 */
export function createHandler(env) {
  const cfg = {
    url: env('LIVEKIT_URL'),
    apiKey: env('LIVEKIT_API_KEY'),
    apiSecret: env('LIVEKIT_API_SECRET'),
    hostPassword: env('HOST_PASSWORD'),
    hostName: env('HOST_NAME') || 'Presenter',
    maxParticipants: Number(env('MAX_PARTICIPANTS') || 300),
  };
  // RoomService talks HTTP(S) to the same server the browser reaches over WS(S).
  const httpUrl = (cfg.url || '').replace(/^ws/, 'http');
  const svc = new RoomServiceClient(httpUrl, cfg.apiKey, cfg.apiSecret);
  const verifier = new TokenVerifier(cfg.apiKey, cfg.apiSecret);

  async function findRoom(name) {
    const [room] = await svc.listRooms([name]);
    return room || null;
  }

  function checkHostPassword(password) {
    if (!cfg.hostPassword) throw new HttpError(500, 'host_password_not_configured');
    if (!safeEqual(password ?? '', cfg.hostPassword)) throw new HttpError(401, 'bad_password');
  }

  async function mintToken(identity, name, grant, attributes) {
    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, name, ttl: '8h' });
    at.addGrant(grant);
    if (attributes) at.attributes = attributes;
    return at.toJwt();
  }

  // ── attendee ────────────────────────────────────────────
  async function join(body) {
    const room = roomName(body.room);
    const name = clean(body.name, 40);
    const id = clean(body.id, 48).replace(/[^A-Za-z0-9-]/g, '');
    if (name.length < 2) throw new HttpError(400, 'bad_name');
    if (id.length < 8) throw new HttpError(400, 'bad_id');

    const info = await findRoom(room);
    if (!info) throw new HttpError(409, 'not_started', 'The presenter has not opened the room yet.');
    const settings = parseSettings(info.metadata);
    if (settings.locked) throw new HttpError(423, 'locked', 'The presenter has locked the room.');
    if (info.numParticipants >= cfg.maxParticipants) throw new HttpError(429, 'full', 'This class is full.');

    const token = await mintToken(`guest_${id}`, name, {
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: false,          // presenter grants this live via the "host" action
      canPublishData: true,       // chat / reactions (presenter can revoke per person)
      canUpdateOwnMetadata: true, // raised-hand attribute
    });
    return { token, url: cfg.url, identity: `guest_${id}` };
  }

  // ── presenter ───────────────────────────────────────────
  async function hostJoin(body) {
    checkHostPassword(body.password);
    const room = roomName(body.room);
    let info = await findRoom(room);
    if (!info) {
      info = await svc.createRoom({
        name: room,
        emptyTimeout: 10 * 60,
        departureTimeout: 5 * 60, // room survives a presenter refresh / network blip
        maxParticipants: cfg.maxParticipants + 20,
        metadata: JSON.stringify({ ...DEFAULT_SETTINGS, title: clean(body.title, 120), startedAt: Date.now() }),
      });
    }
    const token = await mintToken(HOST_IDENTITY, cfg.hostName, {
      roomJoin: true,
      room,
      roomAdmin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    }, { role: 'host' });
    return { token, url: cfg.url, identity: HOST_IDENTITY, settings: parseSettings(info.metadata) };
  }

  async function requireHost(token) {
    let claims;
    try { claims = await verifier.verify(String(token || '')); }
    catch { throw new HttpError(401, 'bad_token'); }
    if (!claims.video?.roomAdmin || claims.sub !== HOST_IDENTITY) throw new HttpError(403, 'not_host');
    return roomName(claims.video.room);
  }

  async function currentPermission(room, identity) {
    const p = await svc.getParticipant(room, identity);
    return p.permission || {};
  }

  async function host(body) {
    const room = await requireHost(body.token);
    const identity = clean(body.identity, 64);

    switch (body.op) {
      case 'settings': {
        const info = await findRoom(room);
        if (!info) throw new HttpError(404, 'no_room');
        const next = { ...parseSettings(info.metadata) };
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (body.settings && key in body.settings) next[key] = body.settings[key];
        }
        next.chat = ['everyone', 'to-host', 'off'].includes(next.chat) ? next.chat : 'everyone';
        next.banner = clean(next.banner, 280);
        next.title = clean(next.title, 120);
        await svc.updateRoomMetadata(room, JSON.stringify(next));
        return { settings: next };
      }

      // Grant / revoke media. sources: subset of ['screen','mic','camera']
      case 'permit': {
        if (!identity || identity === HOST_IDENTITY) throw new HttpError(400, 'bad_identity');
        const want = new Set(Array.isArray(body.sources) ? body.sources : []);
        const sources = [];
        if (want.has('camera')) sources.push(TrackSource.CAMERA);
        if (want.has('mic')) sources.push(TrackSource.MICROPHONE);
        if (want.has('screen')) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
        const perm = await currentPermission(room, identity);
        await svc.updateParticipant(room, identity, {
          permission: {
            canSubscribe: true,
            canPublishData: perm.canPublishData ?? true,
            canUpdateMetadata: true,
            canPublish: sources.length > 0,
            canPublishSources: sources,
          },
        });
        return { ok: true };
      }

      case 'chat-block': {
        if (!identity || identity === HOST_IDENTITY) throw new HttpError(400, 'bad_identity');
        const perm = await currentPermission(room, identity);
        await svc.updateParticipant(room, identity, {
          permission: {
            canSubscribe: true,
            canUpdateMetadata: true,
            canPublish: perm.canPublish ?? false,
            canPublishSources: perm.canPublishSources ?? [],
            canPublishData: !body.blocked,
          },
        });
        return { ok: true };
      }

      // Server-side mute of one published track (mic, camera or screen share).
      case 'mute': {
        const p = await svc.getParticipant(room, identity);
        const kinds = new Set(Array.isArray(body.sources) ? body.sources : ['mic']);
        const map = { mic: TrackSource.MICROPHONE, camera: TrackSource.CAMERA, screen: TrackSource.SCREEN_SHARE, screenAudio: TrackSource.SCREEN_SHARE_AUDIO };
        const targets = [...kinds].map((k) => map[k]).filter((v) => v !== undefined);
        await Promise.all(
          p.tracks.filter((t) => targets.includes(t.source) && !t.muted)
            .map((t) => svc.mutePublishedTrack(room, identity, t.sid, true)),
        );
        return { ok: true };
      }

      case 'mute-all': {
        const list = await svc.listParticipants(room);
        await Promise.all(list.flatMap((p) => p.identity === HOST_IDENTITY ? [] :
          p.tracks.filter((t) => t.source === TrackSource.MICROPHONE && !t.muted)
            .map((t) => svc.mutePublishedTrack(room, p.identity, t.sid, true))));
        return { ok: true };
      }

      // Take everyone off stage (revoke all publish permissions).
      case 'revoke-all': {
        const list = await svc.listParticipants(room);
        await Promise.all(list.filter((p) => p.identity !== HOST_IDENTITY && p.permission?.canPublish)
          .map((p) => svc.updateParticipant(room, p.identity, {
            permission: {
              canSubscribe: true,
              canUpdateMetadata: true,
              canPublishData: p.permission.canPublishData ?? true,
              canPublish: false,
              canPublishSources: [],
            },
          })));
        return { ok: true };
      }

      case 'remove': {
        if (!identity || identity === HOST_IDENTITY) throw new HttpError(400, 'bad_identity');
        await svc.removeParticipant(room, identity);
        return { ok: true };
      }

      case 'end': {
        await svc.deleteRoom(room);
        return { ok: true };
      }

      default:
        throw new HttpError(400, 'bad_op');
    }
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (!cfg.url || !cfg.apiKey || !cfg.apiSecret) {
      return json(500, { error: 'livekit_not_configured', message: 'Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.' });
    }
    try {
      const body = await req.json().catch(() => ({}));
      switch (body.action) {
        case 'join': return json(200, await join(body));
        case 'host-login': checkHostPassword(body.password); return json(200, { ok: true });
        case 'host-join': return json(200, await hostJoin(body));
        case 'host': return json(200, await host(body));
        default: return json(400, { error: 'bad_action' });
      }
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message });
      console.error(err);
      return json(502, { error: 'server_error', message: err?.message || String(err) });
    }
  };
}

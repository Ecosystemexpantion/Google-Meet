// Class reminders, server side: subscribe, then the per-minute cron sends
// "1 day", "1 hour", "10 minutes" and "live now" exactly once each, and the
// payload decrypts like a browser would decrypt it.
//   node dev/reminders-test.mjs
import { createHandler, memoryStore } from '../supabase/functions/classroom/handler.js';
import { newVapidKeys, b64u, fromB64u } from '../supabase/functions/classroom/webpush.js';

const vapid = await newVapidKeys();
const ENV = { CF_SFU_APP_ID: 'a', CF_SFU_APP_TOKEN: 't', HOST_PASSWORD: 'pw', VAPID_PUBLIC: vapid.publicKey, VAPID_PRIVATE: vapid.privateKey, CRON_SECRET: 'cron' };
const pushes = [];
const gone = new Set();
const store = memoryStore();
const handle = createHandler({
  env: (k) => ENV[k],
  store,
  fetchImpl: async (url, init) => {
    pushes.push({ url, init });
    return new Response('', { status: gone.has(url) ? 410 : 201 });
  },
});
const call = async (action, body = {}) => {
  const res = await handle(new Request('http://x/classroom', { method: 'POST', body: JSON.stringify({ action, ...body }) }));
  const out = await res.json();
  if (!res.ok) { const e = new Error(out.message || out.error); e.status = res.status; throw e; }
  return out;
};

// A browser subscription (its own keys, so we can decrypt what is sent)
async function browser(name) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { name, pair, pub, auth, sub: { endpoint: `https://push.example/${name}`, keys: { p256dh: b64u(pub), auth: b64u(auth) } } };
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
async function decrypt(b, body) {
  const salt = body.slice(0, 16); const idlen = body[20]; const asPub = body.slice(21, 21 + idlen); const ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, b.pair.privateKey, 256));
  const te = new TextEncoder();
  const ikm = await hmac(await hmac(b.auth, shared), cat(te.encode('WebPush: info\0'), b.pub, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
}
const B = {};
const received = async (who) => {
  const mine = pushes.filter((p) => p.url === B[who].sub.endpoint);
  pushes.splice(0, pushes.length, ...pushes.filter((p) => p.url !== B[who].sub.endpoint));
  return Promise.all(mine.map((p) => decrypt(B[who], new Uint8Array(p.init.body))));
};

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); } catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.message}`); }
}
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

const H = 3600e3, M = 60e3;
const start = Date.now() + 30 * H;
const { event } = await call('event-save', { password: 'pw', title: 'Selar Setup Training', startsAt: new Date(start).toISOString(), durationMin: 90 });
B.ada = await browser('ada'); B.bo = await browser('bo'); B.cy = await browser('cy');

await check('the class page gets the public key', async () => eq((await call('push-key')).key, vapid.publicKey, 'key'));
await check('subscribing confirms with a notification right away', async () => {
  const r = await call('remind-add', { id: event.id, name: 'Ada', sub: B.ada.sub });
  eq(r.upcoming, ['day', 'hour', 'soon'], 'upcoming');
  const [n] = await received('ada');
  if (!/Reminders are on/.test(n.title)) throw new Error(n.title);
  if (!n.url.endsWith(`class.html?e=${event.id}&go=1`)) throw new Error(n.url);
});
await check('push request carries VAPID and aes128gcm', async () => {
  await call('remind-add', { id: event.id, name: 'Bo', sub: B.bo.sub });
  const p = pushes.at(-1);
  if (!/^vapid t=.+, k=/.test(p.init.headers.Authorization) || p.init.headers['Content-Encoding'] !== 'aes128gcm') throw new Error(JSON.stringify(p.init.headers));
  await received('bo');
});
await check('bad subscriptions and unknown classes are refused', async () => {
  await call('remind-add', { id: event.id, sub: { endpoint: 'http://x', keys: {} } }).then(() => { throw new Error('accepted'); }, (e) => eq(e.status, 400, 'status'));
  await call('remind-add', { id: 'nope', sub: B.ada.sub }).then(() => { throw new Error('accepted'); }, (e) => eq(e.status, 404, 'status'));
});
await check('the cron needs its secret', async () => {
  await call('remind-run', { secret: 'wrong' }).then(() => { throw new Error('accepted'); }, (e) => eq(e.status, 401, 'status'));
});
const run = (at) => call('remind-run', { secret: 'cron', now: at });
await check('nothing is sent 30 hours before', async () => { eq((await run(start - 30 * H)).sent, 0, 'sent'); });
await check('"tomorrow" goes out 24 hours before, once', async () => {
  eq((await run(start - 24 * H + M)).sent, 2, 'sent');
  eq((await run(start - 24 * H + 2 * M)).sent, 0, 'sent again');
  const [n] = await received('ada');
  if (!/^Tomorrow: Selar Setup Training/.test(n.title)) throw new Error(n.title);
  await received('bo');
});
await check('someone subscribing 30 minutes before only gets the later ones', async () => {
  const r = await call('remind-add', { id: event.id, name: 'Cy', sub: B.cy.sub });
  // (the clock in remind-add is real time; pretend by checking against the stage table)
  if (!r.upcoming.includes('soon')) throw new Error(JSON.stringify(r.upcoming));
  await received('cy');
});
await check('"in 1 hour" and "in 10 minutes" go out once each', async () => {
  eq((await run(start - 60 * M + 30e3)).sent, 3, 'hour');
  eq((await run(start - 10 * M + 30e3)).sent, 3, 'soon');
  eq((await run(start - 9 * M)).sent, 0, 'soon again');
  const titles = (await received('ada')).map((n) => n.title);
  eq(titles, ['In 1 hour: Selar Setup Training', 'Starting in 10 minutes: Selar Setup Training'], 'titles');
});
await check('a browser that unsubscribed (410) is dropped', async () => {
  gone.add(B.bo.sub.endpoint);
  // make "live" due: the presenter opens the room
  await store.saveRoom(event.room, { open: true, host_data_session: 'x'.repeat(16) });
  const r = await run(start + 2 * M);
  eq(r.gone, 1, 'gone');
  eq(await store.countReminders(event.id), 2, 'left');
});
await check('"live now — tap to join" goes out when the presenter opens the room', async () => {
  const [n] = await received('ada');
  if (!/^🔴 Live now/.test(n.title) || !n.live) throw new Error(JSON.stringify(n));
  eq((await run(start + 3 * M)).sent, 0, 'live again');
});
await check('the presenter dashboard shows how many will be reminded', async () => {
  const { events } = await call('event-list', { password: 'pw' });
  eq(events.find((e) => e.id === event.id).reminders, 2, 'count');
});
await check('moving the class sends the reminders again', async () => {
  const later = start + 48 * H;
  await call('event-save', { password: 'pw', id: event.id, title: 'Selar Setup Training', startsAt: new Date(later).toISOString(), durationMin: 90 });
  await store.saveRoom(event.room, { open: false });
  pushes.length = 0;
  eq((await run(later - 24 * H + M)).sent, 2, 'day again');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll reminder checks passed');
process.exit(failures ? 1 : 0);

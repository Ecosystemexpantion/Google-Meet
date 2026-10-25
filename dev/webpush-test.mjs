// Checks supabase/functions/classroom/webpush.js against RFC 8291's worked
// example (section 5) and that a VAPID signature verifies.
//   node dev/webpush-test.mjs
import { encrypt, vapidAuth, newVapidKeys, b64u, fromB64u } from '../supabase/functions/classroom/webpush.js';

const body = await encrypt('When I grow up, I want to be a watermelon', {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
}, {
  local: { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8' },
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
});
const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
let ok = b64u(body) === expected;
console.log(ok ? '  ✓ encryption matches RFC 8291 example' : `  ✗ encryption differs\n    got ${b64u(body)}`);

const keys = await newVapidKeys();
const auth = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'mailto:test@example.com' });
const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
const [h, c, s] = jwt.split('.');
const pub = await crypto.subtle.importKey('raw', fromB64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64u(s), new TextEncoder().encode(`${h}.${c}`));
const claims = JSON.parse(new TextDecoder().decode(fromB64u(c)));
const vapidOk = good && claims.aud === 'https://fcm.googleapis.com' && claims.sub === 'mailto:test@example.com';
console.log(vapidOk ? '  ✓ VAPID token is signed and addressed correctly' : '  ✗ VAPID token wrong');
ok &&= vapidOk;
process.exit(ok ? 0 : 1);

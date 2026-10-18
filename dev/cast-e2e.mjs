// Phone screen sharing (EEM26 Cast) end-to-end test.
// A browser page stands in for the Android app and performs the app's exact
// request sequence (see android/.../CastService.kt): sessions/new → push the
// screen + mic with an offer → cast-start heartbeat until told to stop.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:5173';
const ROOM = `Cast${Date.now().toString(36)}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); } catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.message.split('\n')[0]}`); }
}
async function page(opts = {}) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], ...opts });
  const p = await ctx.newPage();
  await p.route('https://cdn.jsdelivr.net/npm/@supabase/**', (r) => r.fulfill({ body: '' }));
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  return p;
}

// Presenter on an Android phone (no getDisplayMedia in phone browsers)
const host = await page({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' });
await host.addInitScript(() => { delete MediaDevices.prototype.getDisplayMedia; });
await host.goto(`${BASE}/host.html`);
await host.evaluate(() => sessionStorage.setItem('eem26_host_pw', 'test'));
await host.goto(`${BASE}/host-room.html?room=${ROOM}`);
await host.click('#pj-start');
await host.waitForSelector('[data-state=live]');
await host.click('#ctl-mic'); // browser mic on, should hand over to the app

const guest = await page({ viewport: { width: 1280, height: 800 } });
await guest.goto(`${BASE}/room.html?rm=${ROOM}&n=Ada&pid=adaadaada01`);
await guest.click('#pj-join');
await guest.waitForSelector('[data-state=live]');

await host.click('#ctl-screen');
let link = '';
await check('phone presenter gets the "Open EEM26 Cast" link', async () => {
  link = await host.getAttribute('#cast-open', 'href');
  if (!/^intent:\/\/cast\?api=.*&token=.*#Intent;scheme=eem26cast;package=io\.eem26\.cast;S\.browser_fallback_url=/.test(link)) throw new Error(link);
});
await host.click('.lv-modal-actions button');
const q = new URLSearchParams(link.slice('intent://cast?'.length, link.indexOf('#Intent')));

// ── the "app" ──
const app = await page();
await app.goto(`${BASE}/cast.html`);
await check('install page offers the APK', async () => { if (!(await app.getAttribute('a[download]', 'href')).endsWith('app/eem26-live.apk')) throw new Error('no apk link'); });
await app.evaluate(async ({ api, token }) => {
  const post = async (path, body, headers = {}) => {
    const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const { iceServers } = await (await fetch(`${api}/sfu/generate-ice-servers`)).json();
  const s = await post('/sfu/sessions/new', null, { 'x-lv-token': token });
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 1280 }, audio: true });
  // same two layers as the app: "f" full size, "h" half size for weak connections
  const tv = pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', sendEncodings: [
    { rid: 'f', maxBitrate: 1_200_000, maxFramerate: 15 },
    { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 300_000, maxFramerate: 10 },
  ] });
  const ta = pc.addTransceiver(stream.getAudioTracks()[0], { direction: 'sendonly' });
  await pc.setLocalDescription(await pc.createOffer());
  const id = crypto.randomUUID().slice(0, 8);
  const screen = { sessionId: s.sessionId, trackName: `cast-screen-${id}`, simulcast: true };
  const mic = { sessionId: s.sessionId, trackName: `cast-mic-${id}` };
  const res = await post(`/sfu/sessions/${s.sessionId}/tracks/new`, {
    sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
    tracks: [{ location: 'local', mid: tv.mid, trackName: screen.trackName }, { location: 'local', mid: ta.mid, trackName: mic.trackName }],
  }, { 'x-lv-sig': s.sig });
  await pc.setRemoteDescription(res.sessionDescription);
  const beat = async () => {
    const r = await post('', { action: 'cast-start', token, screen, mic });
    if (r.stop) { clearInterval(t); pc.close(); stream.getTracks().forEach((x) => x.stop()); await post('', { action: 'cast-stop', token, fromApp: true }); window.castStopped = true; }
  };
  const t = setInterval(beat, 2000);
  await beat();
}, { api: `${BASE}/api/classroom`, token: q.get('token') });

const playing = (p) => p.waitForFunction(() => { const v = document.querySelector('#lv-main video'); return v && v.videoWidth > 0 && !v.paused; }, null, { timeout: 20000 });
await check('presenter sees a preview of the phone share', () => host.waitForSelector('.lv-presenting video', { timeout: 15000 }).then(() => host.waitForFunction(() => document.querySelector('.lv-presenting video')?.videoWidth > 0, null, { timeout: 15000 })));

await check('attendee sees the phone screen', () => playing(guest));
await check('attendee sees "presenting" label', () => guest.waitForFunction(() => /is presenting/.test(document.querySelector('#lv-stage-label').textContent), null, { timeout: 10000 }));
await check('app mic replaces the browser mic', async () => {
  await host.waitForFunction(() => window.__lv.castMic && document.querySelector('#ctl-mic'), null, { timeout: 5000 });
  const micTrack = await guest.evaluate(() => window.__lv.view.host.tracks.mic?.trackName);
  if (!/^cast-mic-/.test(micTrack || '')) throw new Error(`mic track is ${micTrack}`);
});
await host.screenshot({ path: new URL('./screenshots/11-phone-presenting.png', import.meta.url).pathname });

// ── Presenter switches to another app: Android pauses/closes the Chrome tab ──
await host.goto(`${BASE}/cast.html`); // leave the studio (same tab keeps its session)
await check('attendee keeps seeing the phone screen while the presenter page is away', async () => {
  await guest.waitForSelector('#lv-status.info:not(.hidden):has-text("Chat paused")', { timeout: 30000 });
  // nothing may cover the stage
  if (await guest.$('.lv-reconnect')) throw new Error('banner over the stage');
  await playing(guest);
});
await check('chat pauses instead of losing messages', () => guest.waitForSelector('#lv-chat-input[disabled]', { timeout: 5000 }));
const late = await page({ viewport: { width: 390, height: 844 } });
await late.goto(`${BASE}/room.html?rm=${ROOM}&n=Late&pid=latelatelate1`);
await late.click('#pj-join');
await check('someone joining meanwhile still sees the phone screen', () => playing(late));
await check('every viewer gets full quality; a weak connection drops to the lighter layer', async () => {
  const size = (p) => p.evaluate(() => document.querySelector('#lv-main video').videoHeight);
  // viewers start on the light layer for a fast first picture, then step up
  const onFull = () => [...window.__lv.pulls.values()].find((p) => p.kind === 'screen')?.rid === 'f';
  await guest.waitForFunction(onFull, null, { timeout: 30000 });
  await late.waitForFunction(onFull, null, { timeout: 30000 });
  await late.waitForTimeout(3000);
  const [big, phone] = [await size(guest), await size(late)];
  if (!(phone > 0 && phone === big)) throw new Error(`computer ${big}p, phone ${phone}p`);
  // what adaptScreen() does when packets are being lost
  await late.evaluate(() => { const e = [...window.__lv.pulls.values()].find((p) => p.kind === 'screen'); window.__lv.screenQ.holdUntil = Date.now() + 600000; e.rid = 'h'; window.__lv.screenQ.rid = 'h'; e.handle.setRid('h'); });
  await late.waitForFunction((b) => { const h = document.querySelector('#lv-main video').videoHeight; return h > 0 && h <= b * 0.6; }, big, { timeout: 10000 });
});

await check('a very weak connection pauses the screen but keeps the voice, then recovers', async () => {
  await late.evaluate(() => window.__lv.debug.setScreenPaused(true));
  await late.waitForSelector('#lv-main :text("Screen paused")', { timeout: 5000 });
  const kinds = await late.evaluate(() => [...window.__lv.pulls.values()].map((p) => p.kind));
  if (kinds.includes('screen') || !kinds.includes('mic')) throw new Error(`pulls: ${kinds}`);
  await late.click('#lv-main button:has-text("Show the screen anyway")');
  await playing(late);
});

// ── Presenter comes back: the studio rejoins on its own ──
await host.goto(`${BASE}/host-room.html?room=${ROOM}`);
await check('presenter studio rejoins automatically', () => host.waitForSelector('[data-state=live]', { timeout: 20000 }));
await check('attendees reconnect to the presenter (banner clears, chat back)', async () => {
  await guest.waitForSelector('#lv-status.hidden', { state: 'attached', timeout: 45000 });
  await guest.waitForSelector('#lv-chat-input:not([disabled])', { timeout: 5000 });
});
await check('presenter sees the phone share again', () => host.waitForSelector('.lv-presenting video', { timeout: 15000 }));

// ── Presenter mutes while the app provides the microphone ──
const hostMicMuted = () => [...window.__lv.pulls.values()].find((p) => p.owner === 'host' && p.kind === 'mic')?.audio?.muted;
await host.click('#ctl-mic');
await check('presenter can mute the app microphone; attendees go silent', () => guest.waitForFunction((f) => eval(f)() === true, hostMicMuted.toString(), { timeout: 10000 }));
await host.click('#ctl-mic');
await check('…and unmute it again', () => guest.waitForFunction((f) => eval(f)() === false, hostMicMuted.toString(), { timeout: 10000 }));

// ── An attendee on a phone, allowed to share, shares through the EEM26 Live app ──
const bo = await page({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36 EEM26App/2' });
await bo.addInitScript(() => {
  delete MediaDevices.prototype.getDisplayMedia;
  window.EEM26App = { startGuestShare: (api, token) => { window.__shareReq = { api, token }; }, stopShare: () => { window.__stopped = true; } };
});
await bo.goto(`${BASE}/room.html?rm=${ROOM}&n=Bo&pid=bobobobobo01`);
await bo.click('#pj-join');
await bo.waitForSelector('[data-state=live]');
await host.click('#ctl-people');
await host.click('.lv-person:has-text("Bo") .lv-icon-btn');
await host.click('.lv-menu-item:has-text("Allow screen share")');
await bo.waitForSelector('#ctl-screen', { state: 'attached', timeout: 10000 });
await bo.evaluate(() => document.querySelector('#ctl-screen').click());
await check('attendee in the app asks the app to share', () => bo.waitForFunction(() => !!window.__shareReq, null, { timeout: 5000 }));
const req = await bo.evaluate(() => window.__shareReq);
const boScreen = await app.evaluate(async ({ api, token }) => {
  const post = async (path, body, headers = {}) => (await fetch(`${api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })).json();
  const s = await post('/sfu/sessions/new', null, { 'x-lv-token': token });
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 1280 } });
  const tv = pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', sendEncodings: [{ rid: 'f', maxBitrate: 1_500_000 }, { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 450_000 }] });
  await pc.setLocalDescription(await pc.createOffer());
  const trackName = `cast-screen-${crypto.randomUUID().slice(0, 8)}`;
  const res = await post(`/sfu/sessions/${s.sessionId}/tracks/new`, { sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp }, tracks: [{ location: 'local', mid: tv.mid, trackName }] }, { 'x-lv-sig': s.sig });
  await pc.setRemoteDescription(res.sessionDescription);
  window.boPc = pc;
  return { sessionId: s.sessionId, trackName, simulcast: true };
}, { api: req.api, token: req.token });
await bo.evaluate((screen) => window.__eem26Share({ screen }), boScreen);
await check('others see the attendee’s phone screen', () => guest.waitForFunction(() => /Bo is presenting/.test(document.querySelector('#lv-stage-label').textContent) && document.querySelector('#lv-main video')?.videoWidth > 0, null, { timeout: 20000 }));
await bo.evaluate(() => document.querySelector('#ctl-screen').click());
await check('attendee stops sharing from the class page', async () => {
  await bo.waitForFunction(() => window.__stopped === true, null, { timeout: 5000 });
  await guest.waitForFunction(() => !/Bo is presenting/.test(document.querySelector('#lv-stage-label').textContent), null, { timeout: 15000 });
});
await host.click('#ctl-people'); // close the people panel

await host.click('.lv-presenting button:has-text("Stop presenting")');
await check('"Stop presenting" stops the app', () => app.waitForFunction(() => window.castStopped === true, null, { timeout: 15000 }));
await check('attendee stage returns to the presenter', () => guest.waitForFunction(() => !document.querySelector('#lv-main video'), null, { timeout: 15000 }));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll cast checks passed');
process.exit(failures ? 1 : 0);

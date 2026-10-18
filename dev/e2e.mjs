// End-to-end test against the fake Cloudflare SFU (dev/fakesfu) + dev/server.mjs.
//   node dev/e2e.mjs [guestCount]
// Uses Chromium's fake camera/mic/screen so it runs headless.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:5173';
const GUESTS = Number(process.argv[2] || 3);
const ROOM = `E2E${Date.now().toString(36)}`;
const SHOTS = process.env.SHOTS || fileURLToPath(new URL('../dev/screenshots/', import.meta.url));

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-accept-this-tab-capture',
    '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function page(name, viewport = { width: 1440, height: 860 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  await p.route('https://cdn.jsdelivr.net/npm/@supabase/**', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  p.on('pageerror', (e) => console.error(`[${name}] pageerror`, e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.error(`[${name}] console`, m.text()); });
  return p;
}

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.message.split('\n')[0]}`); }
}
const shot = (p, name) => p.screenshot({ path: `${SHOTS}${name}.png` });

console.log(`Room ${ROOM}, ${GUESTS} guests`);

// ── Presenter opens the room ──
const host = await page('host');
await host.goto(`${BASE}/host.html`);
await host.fill('#password-input', 'test');
await host.click('#auth-submit');
await host.waitForSelector('#start-now'); // presenter dashboard
await host.goto(`${BASE}/host-room.html?room=${ROOM}`);
await host.uncheck('#pj-mic');
await shot(host, '01-host-prejoin');
await host.click('#pj-start');
await host.waitForSelector('.lv-app[data-state="live"]');

// ── Attendees join ──
const guests = [];
for (let i = 0; i < GUESTS; i++) {
  const mobile = i === GUESTS - 1;
  const g = await page(`guest${i}`, mobile ? { width: 390, height: 844 } : undefined);
  await g.goto(`${BASE}/room.html?rm=${ROOM}&n=Guest%20${i + 1}&pid=guestpid${i}xyz`);
  if (i === 0) await shot(g, '02-guest-prejoin');
  await g.click('#pj-join');
  guests.push(g);
}
await Promise.all(guests.map((g) => g.waitForSelector('.lv-app[data-state="live"]')));
const [g1, g2] = guests;
const mobile = guests[guests.length - 1];

await check('viewer count reaches everyone', () => host.waitForFunction((n) => Number(document.querySelector('#lv-count').textContent) >= n, GUESTS + 1, { timeout: 15000 }));
await check('attendees have no publish controls', async () => {
  if (await g1.$('#ctl-mic') || await g1.$('#ctl-screen')) throw new Error('guest sees mic/screen');
});

// ── Presenter shares screen (classes are screen + voice; no camera) ──
await host.click('#ctl-screen');
const videoPlaying = (p) => p.waitForFunction(() => {
  const v = document.querySelector('#lv-main video');
  return v && v.videoWidth > 0 && !v.paused;
}, null, { timeout: 20000 });
await check('all attendees receive the presenter screen', () => Promise.all(guests.map(videoPlaying)));
await check('no camera button for anyone', async () => { for (const p of [host, ...guests]) if (await p.$('#ctl-cam')) throw new Error('camera button shown'); });
await check('presenter sees "You’re presenting"', () => host.waitForSelector('.lv-presenting'));

// ── Chat ──
await g1.fill('#lv-chat-input', 'Hello from guest 1 https://example.com');
await g1.press('#lv-chat-input', 'Enter');
await check('chat reaches presenter and other attendees', () => Promise.all([host, g2].map((p) => p.waitForSelector('.lv-msg:has-text("Hello from guest 1")', { timeout: 8000 }))));

// ── Reactions ──
await g2.click('#ctl-react');
await g2.click('.lv-react-pop .lv-emoji >> nth=0');
await check('reaction floats on presenter stage', () => host.waitForSelector('.lv-float', { timeout: 5000 }));
await shot(g1, '03-guest-watching-share');

// ── Hand raise → grant screen share ──
await g1.click('#ctl-hand');
await check('presenter sees raised hand', () => host.waitForFunction(() => document.querySelector('#lv-hands-count').textContent === '1', null, { timeout: 8000 }));
await host.click('#ctl-people');
await host.waitForSelector('.lv-person:has-text("Guest 1") .lv-icon-btn');
await shot(host, '04-host-people-hand');
await host.click('.lv-person:has-text("Guest 1") .lv-icon-btn');
await host.click('.lv-menu-item:has-text("Allow screen share")');
await check('attendee gets a share button after permission', () => g1.waitForSelector('#ctl-screen', { timeout: 8000 }));
await check('hand is lowered after invite', () => g1.waitForFunction(() => !document.querySelector('#ctl-hand')?.classList.contains('active'), null, { timeout: 8000 }));
await g1.click('#ctl-screen');
await check('others see the attendee’s screen', () => g2.waitForFunction(() => /Guest 1 is presenting/.test(document.querySelector('#lv-stage-label').textContent), null, { timeout: 15000 }));
await shot(g2, '05-guest-sees-cohost-share');
await host.click('.lv-person:has-text("Guest 1") .lv-icon-btn');
await host.click('.lv-menu-item:has-text("Take off stage")');
await check('revoking stops their share; stage returns to presenter', () => g2.waitForFunction(() => !/Guest 1/.test(document.querySelector('#lv-stage-label').textContent), null, { timeout: 15000 }));
await check('attendee loses share button', () => g1.waitForSelector('#ctl-screen', { state: 'detached', timeout: 8000 }));

// ── Allow an attendee to speak: everyone must actually hear them ──
const voicePackets = (owner) => `(() => {
  const p = [...window.__lv.pulls.values()].find((x) => x.owner === ${JSON.stringify(owner)} && x.kind === 'mic' && x.track);
  return p?.handle.pc?.getStats(p.track).then((r) => { let n = 0; r.forEach((s) => { if (s.type === 'inbound-rtp') n += s.packetsReceived || 0; }); return n; }) ?? 0;
})()`;
const hears = async (page, owner) => {
  await page.waitForFunction(voicePackets(owner), null, { timeout: 20000 }).catch(() => {});
  const a = await page.evaluate(voicePackets(owner));
  await page.waitForTimeout(2500);
  const b = await page.evaluate(voicePackets(owner));
  if (!(b > a)) throw new Error(`no voice from ${owner} (${a} → ${b})`);
};
await g2.waitForTimeout(3000); // the attendee has been in the class a while before being invited
await host.click('.lv-person:has-text("Guest 2") .lv-icon-btn');
await host.click('.lv-menu-item:has-text("Allow to speak")');
await g2.waitForSelector('#ctl-mic', { timeout: 8000 });
await g2.click('#ctl-mic');
const g2id = await g2.evaluate(() => window.__lv.identity);
await check('everyone hears the attendee who was allowed to speak', () => Promise.all([hears(g1, g2id), hears(guests[2], g2id)]));
await host.click('#ctl-mic');
await check('everyone hears the presenter after they unmute', () => Promise.all([hears(g1, 'host'), hears(g2, 'host')]));

// ── Room controls: chat mode + reactions ──
await host.click('#ctl-room');
await host.click('.lv-seg[data-setting="chat"] button[data-value="to-host"]');
await check('attendee chat becomes private-to-presenter', () => g2.waitForSelector('#lv-composer .lv-chat-note:has-text("privately")', { timeout: 8000 }));
await g2.fill('#lv-chat-input', 'Private question');
await g2.press('#lv-chat-input', 'Enter');
await check('private question reaches presenter only', async () => {
  await host.waitForSelector('.lv-msg.priv:has-text("Private question")', { state: 'attached', timeout: 8000 });
  await g1.waitForTimeout(800);
  if (await g1.$('.lv-msg:has-text("Private question")')) throw new Error('leaked to another attendee');
});
await host.click('.lv-seg[data-setting="chat"] button[data-value="off"]');
await check('chat off disables attendee composer', () => g1.waitForSelector('#lv-chat-input[disabled]', { timeout: 8000 }));
await host.click('.lv-switch-row:has-text("Emoji reactions")');
await check('reactions off hides react button', () => g1.waitForSelector('#ctl-react', { state: 'detached', timeout: 8000 }));
await host.fill('#rc-banner', 'Workbook: https://example.com/workbook');
await host.click('.lv-group:has-text("Pinned announcement") button:has-text("Pin")');
await check('pinned announcement visible to attendees', () => g1.waitForSelector('#lv-banner:not(.hidden):has-text("Workbook")', { timeout: 8000 }));
await shot(host, '06-host-controls');

// ── Poll ──
await host.click('#ctl-polls');
await host.fill('.lv-polls input[placeholder="Ask a question…"]', 'Have you created a Selar account?');
await host.click('button:has-text("Launch poll")');
await check('attendees receive the poll', () => g2.waitForSelector('.lv-poll-q:has-text("Selar account")', { timeout: 8000 }));
await g1.click('#ctl-polls');
await g1.click('.lv-poll-opt:has-text("Yes")');
await g2.click('.lv-poll-opt:has-text("No")');
await check('presenter tallies votes', () => host.waitForSelector('.lv-poll .muted:has-text("2 votes")', { timeout: 8000 }));
await check('attendees see live results', () => g1.waitForSelector('.lv-poll-pct:has-text("50%")', { timeout: 8000 }));
await shot(g1, '07-guest-poll');
await shot(mobile, '08-mobile');

// ── Late joiner gets chat history + poll ──
const late = await page('late');
await late.goto(`${BASE}/room.html?rm=${ROOM}&n=Late%20Comer&pid=latepid123xyz`);
await late.click('#pj-join');
await check('late joiner receives chat history', () => late.waitForSelector('.lv-msg:has-text("Hello from guest 1")', { timeout: 10000 }));
await check('late joiner sees the presenter screen', () => videoPlaying(late));

// ── Lock + remove ──
await host.click('#ctl-room');
await host.click('.lv-switch-row:has-text("Lock room")');
await host.waitForTimeout(800);
const locked = await (await fetch(`${BASE}/api/classroom`, { method: 'POST', body: JSON.stringify({ action: 'join', room: ROOM, name: 'Blocked', id: 'blockedid123' }) })).json();
await check('locked room rejects new joins', async () => { if (locked.error !== 'locked') throw new Error(JSON.stringify(locked)); });
await host.click('#ctl-people');
await host.click('.lv-person:has-text("Late Comer") .lv-icon-btn');
await host.click('.lv-menu-item:has-text("Remove from class")');
await host.click('.lv-modal .lv-btn.danger');
await check('removed attendee sees removal screen', () => late.waitForSelector('h1:has-text("removed")', { timeout: 8000 }));

// ── End class ──
await host.click('#ctl-end');
await host.click('.lv-modal button:has-text("End for everyone")');
await check('everyone sees the closing message', () => Promise.all(guests.map((g) => g.waitForSelector('h1:has-text("The class has ended")', { timeout: 10000 }))));
await shot(g1, '09-ended');

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

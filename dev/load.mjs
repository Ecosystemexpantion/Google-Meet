// Scale check: the presenter shares a screen in a real browser, dev/fakesfu
// loadbot adds N headless attendees through the real join flow, then a real
// phone-sized attendee joins and must still get smooth video and chat.
//   node dev/load.mjs 200        (needs dev/server.mjs + fakesfu running,
//                                 LOADBOT=/path/to/loadbot or `go build`)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:5173';
const N = Number(process.argv[2] || 200);
const ROOM = `Load${Date.now().toString(36)}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'] });

async function page(viewport = { width: 1440, height: 860 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  await p.route('https://cdn.jsdelivr.net/npm/@supabase/**', (r) => r.fulfill({ body: '' }));
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  return p;
}

const host = await page();
await host.goto(`${BASE}/host.html`);
await host.evaluate(() => localStorage.setItem('eem26_host_pw', JSON.stringify({ v: 'test', exp: Date.now() + 3600e3 })));
await host.goto(`${BASE}/host-room.html?room=${ROOM}`);
await host.click('#pj-start');
await host.waitForSelector('.lv-app[data-state="live"]');
await host.click('#ctl-screen');
await host.waitForSelector('.lv-presenting');
console.log(`Presenter sharing in ${ROOM}; adding ${N} attendees…`);

const bots = spawn(process.env.LOADBOT || 'loadbot', ['-room', ROOM, '-n', String(N), '-d', '90s', '-rate', '10'], { stdio: ['ignore', 'pipe', 'pipe'] });
let botLog = '';
bots.stdout.on('data', (d) => { botLog += d; process.stdout.write(`  [bots] ${d}`); });
bots.stderr.on('data', (d) => { botLog += d; });

await host.waitForFunction((n) => Number(document.querySelector('#lv-count').textContent) >= n, N, { timeout: 120000 });
console.log(`Viewer count on presenter: ${await host.textContent('#lv-count')}`);

const guest = await page({ width: 390, height: 844 });
await guest.goto(`${BASE}/room.html?rm=${ROOM}&n=Phone%20Viewer&pid=phoneviewer01`);
await guest.click('#pj-join');
await guest.waitForFunction(() => { const v = document.querySelector('#lv-main video'); return v && v.videoWidth > 0; }, null, { timeout: 30000 });
const fps = await guest.evaluate(async () => {
  const v = document.querySelector('#lv-main video');
  const a = v.getVideoPlaybackQuality().totalVideoFrames;
  await new Promise((r) => setTimeout(r, 10000));
  const q = v.getVideoPlaybackQuality();
  return { fps: (q.totalVideoFrames - a) / 10, dropped: q.droppedVideoFrames, width: v.videoWidth, height: v.videoHeight };
});
console.log('Phone attendee playback under load:', fps);

await host.click('#ctl-people');
const t0 = Date.now();
await host.waitForSelector('.lv-person >> nth=150');
console.log(`People list rendered ${await host.locator('.lv-person').count()} rows in ${Date.now() - t0} ms`);

await guest.click('#ctl-chat');
await guest.fill('#lv-chat-input', 'Can everyone see the screen?');
await guest.press('#lv-chat-input', 'Enter');
await host.waitForSelector('.lv-msg:has-text("Can everyone see")', { state: 'attached', timeout: 10000 });
console.log('Phone attendee chat reached the presenter');
await host.click('#ctl-chat');
await host.fill('#lv-chat-input', 'Yes — welcome everyone!');
await host.press('#lv-chat-input', 'Enter');
await guest.waitForSelector('.lv-msg:has-text("welcome everyone")', { timeout: 10000 });
console.log('Presenter chat reached the phone attendee');
const hostStats = await host.evaluate(() => ({ people: window.__lv.people.size, heap: Math.round(performance.memory?.usedJSHeapSize / 1e6) }));
console.log('Presenter tab:', hostStats);

await new Promise((r) => bots.on('exit', r));
console.log(botLog.split('\n').filter((l) => /FINAL|joined/.test(l)).slice(-3).join('\n'));
await browser.close();

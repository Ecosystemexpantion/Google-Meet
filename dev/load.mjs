// Scale check: presenter shares screen in a real browser, `lk load-test` adds
// N headless subscribers, then a real attendee browser joins and must still
// get smooth video. Needs the LiveKit CLI (`lk`) on PATH or LK_CLI=/path/to/lk.
//   node dev/load.mjs 200
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:5173';
const N = Number(process.argv[2] || 200);
const ROOM = `Load${Date.now().toString(36)}`;
const LK_ESM = await readFile(fileURLToPath(new URL('../node_modules/livekit-client/dist/livekit-client.esm.mjs', import.meta.url)));
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'] });

async function page(viewport = { width: 1440, height: 860 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  await p.route('https://cdn.jsdelivr.net/npm/livekit-client@*/**', (r) => r.fulfill({ body: LK_ESM, contentType: 'text/javascript' }));
  await p.route('https://cdn.jsdelivr.net/npm/@supabase/**', (r) => r.fulfill({ body: '' }));
  return p;
}

const host = await page();
await host.goto(`${BASE}/host.html`);
await host.evaluate(() => sessionStorage.setItem('eem26_host_pw', 'test'));
await host.goto(`${BASE}/host-room.html?room=${ROOM}`);
await host.click('#pj-start');
await host.waitForSelector('.lv-app[data-state="live"]');
await host.click('#ctl-screen');
await host.waitForSelector('.lv-presenting');
console.log(`Presenter sharing in ${ROOM}; adding ${N} subscribers…`);

const lk = spawn(process.env.LK_CLI || 'lk', ['load-test', '--url', 'ws://localhost:7880', '--api-key', 'devkey', '--api-secret', 'secret',
  '--room', ROOM, '--subscribers', String(N), '--duration', '75s', '--num-per-second', '20'], { stdio: ['ignore', 'pipe', 'pipe'] });
let lkOut = '';
lk.stdout.on('data', (d) => { lkOut += d; });
lk.stderr.on('data', (d) => { lkOut += d; });

await host.waitForFunction((n) => Number(document.querySelector('#lv-count').textContent) >= n, N, { timeout: 60000 });
console.log(`Viewer count on presenter: ${await host.textContent('#lv-count')}`);

const guest = await page({ width: 390, height: 844 });
await guest.goto(`${BASE}/room.html?rm=${ROOM}&n=Phone%20Viewer&pid=phoneviewer01`);
await guest.click('#pj-join');
await guest.waitForFunction(() => { const v = document.querySelector('#lv-main video'); return v && v.videoWidth > 0; }, null, { timeout: 30000 });

// Measure decoded frames over 10s on the real attendee.
const fps = await guest.evaluate(async () => {
  const v = document.querySelector('#lv-main video');
  const a = v.getVideoPlaybackQuality().totalVideoFrames;
  await new Promise((r) => setTimeout(r, 10000));
  const q = v.getVideoPlaybackQuality();
  return { fps: (q.totalVideoFrames - a) / 10, dropped: q.droppedVideoFrames, width: v.videoWidth, height: v.videoHeight };
});
console.log('Attendee playback with load:', fps);

// Presenter UI responsiveness with N people listed
await host.click('#ctl-people');
const t0 = Date.now();
await host.waitForSelector('.lv-person >> nth=150');
console.log(`People list rendered ${await host.locator('.lv-person').count()} rows in ${Date.now() - t0} ms`);
await guest.click('#ctl-chat');
await guest.fill('#lv-chat-input', 'Can everyone see the screen?');
await guest.press('#lv-chat-input', 'Enter');
await host.waitForSelector('.lv-msg:has-text("Can everyone see")', { state: 'attached', timeout: 10000 });
console.log('Chat delivered with load');

await new Promise((r) => lk.on('exit', r));
console.log(lkOut.split('\n').filter((l) => /Summary|Total|Subscriber|Track|Latency|Error|Bitrate|Packet|│|\|/i.test(l)).slice(-25).join('\n'));
await browser.close();

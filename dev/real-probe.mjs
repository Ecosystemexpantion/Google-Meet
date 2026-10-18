// Real-class check: one real Chrome attendee (phone-sized) joins the live
// class on the published site while the load bots fill it up, and measures
// what a person would notice: did the presenter's screen show, how smooth is
// it (frames per second, freezes), does the viewer count climb, does chat flow.
//   SITE=https://…/ ROOM=MyRoom MINUTES=5 node dev/real-probe.mjs
// Run by .github/workflows/loadtest.yml; writes a summary for the run page.
import { chromium } from 'playwright';
import { appendFileSync } from 'node:fs';

const SITE = (process.env.SITE || 'https://ecosystemexpantion.github.io/Google-Meet/').replace(/\/?$/, '/');
const ROOM = process.env.ROOM;
const MINUTES = Number(process.env.MINUTES || 5);
if (!ROOM) throw new Error('ROOM is required');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.error('pageerror', e.message));

const t0 = Date.now();
await p.goto(`${SITE}room.html?rm=${encodeURIComponent(ROOM)}&n=${encodeURIComponent('Test probe')}`);
await p.click('#pj-join');
await p.waitForSelector('[data-state=live]', { timeout: 60000 });
const joinedIn = (Date.now() - t0) / 1000;
console.log(`joined in ${joinedIn.toFixed(1)} s`);

let videoIn = null;
try {
  await p.waitForFunction(() => { const v = document.querySelector('#lv-main video'); return v && v.videoWidth > 0; }, null, { timeout: 60000 });
  videoIn = (Date.now() - t0) / 1000;
  console.log(`presenter screen showing after ${videoIn.toFixed(1)} s`);
} catch {
  console.log('presenter screen did not show within 60 s (is the presenter sharing?)');
}

// Sample once a second: frames shown, size, viewer count, chat messages.
const samples = [];
const end = Date.now() + MINUTES * 60_000;
while (Date.now() < end) {
  samples.push(await p.evaluate(() => {
    const v = document.querySelector('#lv-main video');
    const q = v?.getVideoPlaybackQuality?.();
    return {
      at: Date.now(),
      frames: q ? q.totalVideoFrames - q.droppedVideoFrames : 0,
      h: v?.videoHeight || 0,
      rid: [...(window.__lv?.pulls?.values() || [])].find((x) => x.kind === 'screen')?.rid || '',
      count: Number(document.querySelector('#lv-count')?.textContent || 0),
      chats: document.querySelectorAll('#lv-chat-list .lv-msg').length,
      status: document.querySelector('#lv-status:not(.hidden)')?.textContent || '',
    };
  }));
  const s = samples.at(-1), prev = samples.at(-2);
  if (samples.length % 15 === 0 && prev) console.log(`viewers ${s.count} · ${s.h}p (${s.rid || '-'}) · ${s.frames - prev.frames} fps · chat ${s.chats}${s.status ? ` · ${s.status}` : ''}`);
  await p.waitForTimeout(1000);
}
await browser.close();

// Seconds where the picture did not change for 2+ s count as freezes.
// Screens that are not changing still send ~1 frame a second, so the
// frame rate is shown, not judged.
let freezes = 0, still = 0;
const fps = [];
for (let i = 1; i < samples.length; i++) {
  const d = samples[i].frames - samples[i - 1].frames;
  fps.push(d);
  if (d === 0) { if (++still === 2) freezes++; } else still = 0;
}
const avg = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : 0;
const peak = Math.max(0, ...samples.map((s) => s.count));
const last = samples.at(-1) || {};
const lines = [
  `## Live class test: ${ROOM}`,
  '',
  '| What | Result |',
  '|---|---|',
  `| Joined the class | ${joinedIn.toFixed(1)} s |`,
  `| Presenter screen showed | ${videoIn == null ? '**no**' : `${videoIn.toFixed(1)} s`} |`,
  `| Picture size (phone viewer) | ${last.h || 0}p |`,
  `| Time on the lighter layer | ${Math.round(100 * samples.filter((s) => s.rid === 'h').length / Math.max(1, samples.length))}% |`,
  `| Average frames per second | ${avg.toFixed(1)} |`,
  `| Freezes (2 s+ with no new frame) | ${freezes} |`,
  `| Most people in the class | ${peak} |`,
  `| Chat messages seen | ${last.chats || 0} |`,
  `| Connection notices | ${[...new Set(samples.map((s) => s.status).filter(Boolean))].join(', ') || 'none'} |`,
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(videoIn == null ? 1 : 0);

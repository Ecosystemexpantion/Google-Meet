// Scheduling end-to-end: the presenter schedules a class on the dashboard,
// shares the link; an attendee opens it, sees the countdown, enters their
// name early and is taken in automatically when the presenter starts.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:5173';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); } catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.message.split('\n')[0]}`); }
}
async function page(viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  await p.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '' }));
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  return p;
}

const host = await page();
await host.goto(`${BASE}/host.html`);
await host.fill('#password-input', 'test');
await host.click('#auth-submit');
await check('presenter sees the dashboard', () => host.waitForSelector('#start-now'));
const title = `Selar Live ${Date.now().toString(36)}`;
await host.fill('#ev-title', title);
// starts in 2 hours
await host.evaluate(() => {
  const d = new Date(Date.now() + 2 * 3600e3);
  const off = d.getTimezoneOffset() * 60e3;
  document.querySelector('#ev-when').value = new Date(d.getTime() - off).toISOString().slice(0, 16);
});
await host.fill('#ev-desc', 'Set up your store and take payments.');
await host.click('#ev-save');
let link = '';
await check('scheduling gives a shareable link', async () => {
  await host.waitForSelector('.created .linkbox span', { timeout: 8000 });
  link = await host.textContent('.created .linkbox span');
  if (!/class\.html\?e=\w+/.test(link)) throw new Error(link);
});
await check('the class is listed with a Start button', () => host.waitForSelector(`.item:has-text("${title}") a:has-text("Start")`, { timeout: 8000 }));
await host.screenshot({ path: `${SHOTS}20-dashboard.png`, fullPage: true });

const guest = await page({ width: 390, height: 844 });
await guest.goto(link);
await check('class page shows the title and a running countdown', async () => {
  await guest.waitForSelector(`h1:has-text("${title}")`, { timeout: 8000 });
  const a = await guest.textContent('.clock');
  await guest.waitForTimeout(1500);
  const b = await guest.textContent('.clock');
  if (a === b) throw new Error(`countdown not moving: ${a}`);
});
await guest.screenshot({ path: `${SHOTS}21-class-countdown.png`, fullPage: true });
await guest.fill('#name', 'Ada Lovelace');
await guest.click('#join');
await check('attendee can wait to be let in', () => guest.waitForSelector('#join[disabled]'));

// presenter starts from the dashboard
await host.click(`.item:has-text("${title}") a:has-text("Start")`);
await host.waitForURL(/host-room/);
await check('studio is titled after the class', async () => { const v = await host.inputValue('#pj-title'); if (v !== title) throw new Error(v); });
await host.uncheck('#pj-mic');
await host.click('#pj-start');
await host.waitForSelector('[data-state=live]');
await check('waiting attendee is taken into the class automatically', async () => {
  await guest.waitForURL(/room\.html/, { timeout: 30000 });
  await guest.waitForSelector('[data-state=live]', { timeout: 20000 });
});
await check('presenter sees the attendee', () => host.waitForFunction(() => Number(document.querySelector('#lv-count').textContent) >= 2, null, { timeout: 15000 }));
await guest.screenshot({ path: `${SHOTS}22-guest-in-class.png` });
await host.screenshot({ path: `${SHOTS}23-studio.png` });

const home = await page({ width: 390, height: 844 });
await home.goto(`${BASE}/index.html`);
await check('home page shows the class that is live', () => home.waitForSelector('#next .chip.live', { timeout: 10000 }));
await home.screenshot({ path: `${SHOTS}24-home.png`, fullPage: true });

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll scheduling checks passed');
process.exit(failures ? 1 : 0);

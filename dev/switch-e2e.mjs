// The app is still sharing into another class: tapping Share screen in this
// class must move the share here (stop, then start), not refuse.
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:5173';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
const p = await ctx.newPage();
await p.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '' }));
await p.addInitScript(() => {
  delete MediaDevices.prototype.getDisplayMedia;
  let sharing = true; // a share left running in another class
  window.calls = [];
  window.EEM26App = {
    isSharing: () => sharing,
    stopShare: () => { window.calls.push('stop'); setTimeout(() => { sharing = false; }, 600); },
    startShare: (api, token, room) => { window.calls.push(`start:${room}`); },
  };
});
await p.goto(`${BASE}/host.html`);
await p.evaluate(() => sessionStorage.setItem('eem26_host_pw', 'test'));
const room = `Switch${Date.now().toString(36)}`;
await p.goto(`${BASE}/host-room.html?room=${room}`);
await p.uncheck('#pj-mic');
await p.click('#pj-start');
await p.waitForSelector('[data-state=live]');
await p.evaluate(() => document.querySelector('#ctl-screen').click());
await p.waitForFunction((r) => window.calls.includes(`start:${r}`), room, { timeout: 8000 });
const calls = await p.evaluate(() => window.calls);
await browser.close();
const ok = calls[0] === 'stop' && calls[1] === `start:${room}`;
console.log(ok ? '  ✓ share moves into this class (stop → start)' : `  ✗ wrong order: ${calls}`);
process.exit(ok ? 0 : 1);

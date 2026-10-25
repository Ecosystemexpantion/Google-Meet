// ─── EEM26 Live service worker: class reminders ───────────
// Shows the push notifications the classroom server sends (1 day, 1 hour and
// 10 minutes before a class, and "live now"). Tapping one opens the class
// page, which takes the person straight in once the class is live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'EEM26 Live class', {
    body: d.body || '',
    icon: 'app/icon-192.png',
    badge: 'app/badge-96.png',
    tag: d.tag || 'eem26',
    renotify: true,
    requireInteraction: !!d.live,
    vibrate: d.live ? [200, 100, 200, 100, 200] : [120, 60, 120],
    data: { url: d.url || './' },
    actions: d.live ? [{ action: 'join', title: 'Join now' }] : [],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  const id = new URL(url).searchParams.get('e');
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // the class page is already open: bring it forward (it joins by itself)
    const open = tabs.find((c) => id && new URL(c.url).searchParams.get('e') === id);
    if (open) {
      await open.focus();
      try { await open.navigate(url); } catch { /* not controlled by us */ }
      return;
    }
    await self.clients.openWindow(url);
  })());
});

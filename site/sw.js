// PRJ Logistics: lets the site open like an app and keep working when the signal drops.
const CACHE = 'prj-v7';
const SHELL = ['./', 'index.html', 'privacy.html', 'track.html', 'insurance.html', 'deliveries.html', 'manifest.webmanifest', 'icon-192-v2.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Our own files: try the network first (so updates show up), fall back to the saved copy.
// Maps, address search, tracking and forms are never cached.
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r).then(m => m || caches.match('index.html')))
  );
});

// Phone notifications for the office (turned on with the bell in the admin panel)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'PRJ Logistics', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'PRJ Logistics', {
    body: d.body || '', icon: 'admin-icon-192.png', badge: 'admin-icon-192.png', tag: 'prj-' + Date.now(), data: { url: d.url || 'admin.html' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || 'admin.html', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.indexOf('admin.html') >= 0 && 'focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return clients.openWindow(url);
  }));
});

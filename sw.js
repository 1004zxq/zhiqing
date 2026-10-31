const CACHE = 'zhiqing-static-v4';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(res => {
        if (res && res.ok) caches.open(CACHE).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

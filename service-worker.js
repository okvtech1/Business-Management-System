const CACHE = 'okv-biztrack-online-v1';
const SHELL = [
  'login.html', 'signup.html', 'reset-password.html', 'install.html', 'dashboard.html',
  'pricing.html', 'demo.html', 'index.html',
  'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache the API — data must always be fresh / genuinely online.
  if (url.hostname.includes('script.google.com')) return;

  // App shell: cache-first, falling back to network, so install/login screens load instantly.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      }).catch(() => cached);
    })
  );
});

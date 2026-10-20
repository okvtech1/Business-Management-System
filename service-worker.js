// v2: pages and scripts are now NETWORK-FIRST (fall back to the cached copy only when offline), so a
// fresh deploy of dashboard.html / demo.html / app-common.js reaches returning visitors immediately
// instead of being masked by an old cached copy. Icons and the manifest stay cache-first.
const CACHE = 'okv-biztrack-online-v2';
const SHELL = [
  'login.html', 'signup.html', 'reset-password.html', 'install.html', 'dashboard.html', 'super-admin.html',
  'pricing.html', 'demo.html', 'index.html', 'app-common.js',
  'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  // One missing file must not abort the whole install, so add each entry independently.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache the API (and never touch anything that isn't a plain GET) — data must be genuinely fresh.
  if (req.method !== 'GET' || url.hostname.includes('script.google.com')) return;

  const isPageOrCode = req.mode === 'navigate' || /\.(html|js|css)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isPageOrCode) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => cached))
  );
});

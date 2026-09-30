const CACHE = 'nios-student-app-assets-v3';
// Only public, user-independent assets may be cached. In particular, never
// cache the protected HTML route: the server may return either the Student App
// or the sign-in page for the same URL depending on the current session.
const APP_ASSETS = [
  '/student-app.css',
  '/student-app.js',
  '/student-app.webmanifest',
  '/student-app-icon.svg'
];

// Student HTML, records, document links and API responses are deliberately
// never cached. Offline storage contains only the non-sensitive app assets.
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (!APP_ASSETS.includes(url.pathname)) return;

  // Network-first keeps security and UI fixes immediately available. The cache
  // is only an offline fallback for public static assets.
  event.respondWith(fetch(request).then(response => {
    const cacheControl = response.headers.get('cache-control') || '';
    if (response.ok && !/\b(?:no-store|private)\b/i.test(cacheControl)) {
      caches.open(CACHE).then(cache => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => caches.match(request)));
});

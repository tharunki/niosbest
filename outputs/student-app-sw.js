const CACHE = 'nios-student-app-shell-v2';
const APP_SHELL = [
  '/student-app.html',
  '/student-app.css',
  '/student-app.js',
  '/student-app.webmanifest',
  '/student-app-icon.svg'
];

// Student records, document links and API responses are deliberately never
// cached. Installing this app only makes the public shell available offline.
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const shellPath = url.pathname === '/student-app.html' || APP_SHELL.includes(url.pathname);
  if (!shellPath) return;

  // Network-first keeps security and UI fixes immediately available. The cached
  // shell is only the offline fallback; private API data is never cached.
  event.respondWith(fetch(request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
    return response;
  }).catch(() => caches.match(request)));
});

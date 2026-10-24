// Offline app shell. Map tiles and API calls are NOT cached (provider policies forbid
// bulk tile caching and live lookups must stay fresh); saved jobs live in browser storage.
const CACHE = 'slp-shell-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'js/app.js', 'js/geo.js', 'js/postcode.js', 'js/direction.js', 'js/geocoding.js',
  'js/obstructions.js', 'js/assessment.js', 'js/store.js', 'js/report.js', 'js/photos.js',
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first so updates arrive; fall back to the cached shell offline.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request).then((r) => r ?? caches.match('index.html'))));
});

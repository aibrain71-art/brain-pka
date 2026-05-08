// PKA Service Worker — gives the app offline-cache + PWA-install capability.
// Cache-first for our own static files, network-first for everything else
// (Wikipedia / ElevenLabs / YouTube thumbnails) so live data stays fresh.
const VERSION = 'pka-v47';
const CORE = [
  './',
  './index.html',
  './pwa.webmanifest',
  './Garden/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(CORE).catch(err => console.warn('SW pre-cache:', err)))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VERSION).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === location.origin;
  // Don't cache POST / share-target submissions or non-GET
  if (e.request.method !== 'GET') return;
  if (sameOrigin) {
    // Cache-first for our own files. Always returns a Response — when offline
    // AND nothing is cached, synthesise a 503 so respondWith() never gets
    // undefined (which would throw "Failed to convert value to 'Response'").
    e.respondWith(
      caches.match(e.request).then(hit =>
        hit || fetch(e.request).then(res => {
          // Update cache opportunistically
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
          return res;
        }).catch(() => hit || new Response('Offline and not cached', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        }))
      )
    );
  }
  // Cross-origin (Wikipedia / Garden thumbs / ElevenLabs / etc) → pass through
});

// PKA Service Worker — gives the app offline-cache + PWA-install capability.
// Cache-first for our own static files, network-first for everything else
// (Wikipedia / ElevenLabs / YouTube thumbnails) so live data stays fresh.
const VERSION = 'pka-v65';
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
  if (!sameOrigin) return;  // Cross-origin (Wikipedia / ElevenLabs etc) → pass through

  // Strategy split:
  // - HTML shell (index.html / root navigations) → NETWORK-FIRST so new
  //   deploys always show up immediately. Cache only as offline fallback.
  //   Without this, users see old code for hours after a deploy because
  //   cache-first never re-checks the network.
  // - /api/* → never cached (always fetch fresh — these are data endpoints)
  // - Everything else (icons, manifest, fonts) → CACHE-FIRST for speed.
  const isHtmlShell = url.pathname === '/' ||
                      url.pathname.endsWith('/index.html') ||
                      e.request.mode === 'navigate';
  const isApi = url.pathname.startsWith('/api/');

  if (isApi) {
    // Never cache API calls — they're always live
    return;
  }

  if (isHtmlShell) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(() =>
        caches.match(e.request).then(hit => hit || new Response('Offline and not cached', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        }))
      )
    );
    return;
  }

  // Cache-first for static assets (icons, manifest, etc.)
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(() => hit || new Response('Offline and not cached', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
      }))
    )
  );
});

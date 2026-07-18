// ============================================================================
// sw.js — service worker. Makes the app installable and fast/offline on reload.
//
// Scope note: registered with a relative URL ('./sw.js'), so on GitHub Pages
// project hosting (…/localundercover/) the scope is that subdirectory and all
// precache URLs below resolve relative to THIS file — never use root-absolute
// paths or the app breaks under a subpath.
//
// Caching strategy:
//   - App shell (local HTML/CSS/JS/icons): cache-first, refreshed in the
//     background so a redeploy is picked up on the next visit.
//   - Cross-origin (Google Fonts, the PeerJS CDN): network-first, falling back
//     to whatever we cached last time. P2P itself still needs the broker
//     reachable for the first handshake — the SW can't make that work offline.
// ============================================================================

const VERSION = 'uc-v11';
const CACHE = `localundercover-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/ui.js',
  './js/state.js',
  './js/net.js',
  './js/config.js',
  './js/rules.js',
  './js/words.js',
  './js/util.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Best-effort: one missing file shouldn't abort the whole install.
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // SPA navigations: serve the cached shell so a reload works offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', net.clone());
        return net;
      } catch (_) {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  if (sameOrigin) {
    // Cache-first with background refresh.
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
    return;
  }

  // Cross-origin (fonts, PeerJS): network-first, fall back to cache.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (_) {
      return (await caches.match(req)) || Response.error();
    }
  })());
});

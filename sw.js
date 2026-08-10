/* Service worker — makes the library readable offline.
 *
 * Two caching strategies, because the two kinds of asset have opposite needs:
 *
 *   App shell (HTML/CSS/JS/fonts) — cache-first, refreshed on activate. Small,
 *   changes only when the app is rebuilt.
 *
 *   data/library.json — cache-first keyed by its ?v=<content-hash>. The blob is
 *   large and immutable for a given hash, so once cached it never re-downloads.
 *   Old versions are evicted when a new hash appears. data/version.json is
 *   always network-first so a rebuild is noticed immediately.
 *
 * Note: only ciphertext is ever cached. The decryption key lives in IndexedDB
 * and is never touched here.
 */

const SHELL_CACHE = 'library-shell-v1';
const DATA_CACHE = 'library-data-v1';

const SHELL_ASSETS = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'favicon.svg',
  'assets/css/style.css',
  'assets/css/fonts.css',
  'assets/js/app.js',
  'assets/js/paginate.js',
  'assets/vendor/page-flip.browser.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individual failures (e.g. a font 404) must not abort the whole install.
      .then((cache) =>
        Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n !== SHELL_CACHE && n !== DATA_CACHE)
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Always try the network first for the version pointer so a rebuild is seen
  // as soon as the device is online; fall back to cache when offline.
  if (url.pathname.endsWith('/data/version.json')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // The encrypted library: immutable per ?v= hash, so cache-first forever.
  if (url.pathname.endsWith('/data/library.json')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) {
          // Drop older builds of the blob before storing this one.
          for (const key of await cache.keys()) {
            if (
              key.url.includes('/data/library.json') &&
              key.url !== request.url
            ) {
              await cache.delete(key);
            }
          }
          cache.put(request, res.clone());
        }
        return res;
      })
    );
    return;
  }

  // App shell: cache-first, refreshing the entry in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        fetch(request)
          .then((res) => {
            if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(request, res));
          })
          .catch(() => {});
        return hit;
      }
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});

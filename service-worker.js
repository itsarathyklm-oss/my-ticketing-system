const CACHE_NAME = 'sarathy-it-v3';
const STATIC_ASSETS = [
  '/logo.png',
  '/background.png',
  '/icon-512.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only cache GET requests for static assets (images, manifest)
  // Skip all pages, API calls, and POST requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const path = url.pathname;

  // Only cache actual static files — never cache pages or API endpoints
  const isStaticFile = /\.(png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?|ttf|eot)$/.test(path) ||
                        path === '/manifest.json';

  if (!isStaticFile) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetched;
    })
  );
});

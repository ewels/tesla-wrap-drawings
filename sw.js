const CACHE = 'crayon-to-car';
const SHELL = ['./', 'car3d.js', 'style.css', 'app.js', 'worker.js', 'align.js', 'models.js', 'fonts/archivo.woff2', 'icon-192.png'];

addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) =>
  c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))));
addEventListener('activate', (e) => e.waitUntil(clients.claim()));

// Network first so a new deploy shows up immediately; the cache is the offline fallback.
addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then((cache) =>
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
      .catch(async () => (await cache.match(e.request, { ignoreSearch: true })) ?? Response.error())));
});

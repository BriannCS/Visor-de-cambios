/* Service worker: abre al instante y sin red.
 * Archivos propios, fuentes y html2canvas → caché y se actualizan en segundo plano.
 * Las tasas (Apps Script) NUNCA pasan por aquí: siempre van a la red
 * (el Index ya guarda el último dato en localStorage). */
const CACHE = 'visor-v1';
const BASE = ['./', 'index.html', 'config.js', 'puente.js', 'manifest.webmanifest',
              'icons/icon-192.png', 'icons/icon-512.png'];
const EXTERNOS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const propio = url.origin === location.origin;
  if (!propio && !EXTERNOS.test(req.url)) return;

  e.respondWith(caches.open(CACHE).then(async c => {
    const guardado = await c.match(req, { ignoreSearch: propio });
    const red = fetch(req)
      .then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; })
      .catch(() => guardado);
    if (guardado) { e.waitUntil(red); return guardado; }
    return red;
  }));
});

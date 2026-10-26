const CACHE = 'keuangan-v3'; // naikkan jadi v2, v3, ... setiap kali kamu mengubah file aplikasi
const FILES = [
  '/', '/index.html', '/style.css', '/app.js', '/firebase.js', '/config.js',
  '/utils.js', '/csv.js', '/manifest.json', '/icons/192.png', '/icons/512.png',
];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'www.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const allowed = url.origin === location.origin || CDN_HOSTS.includes(url.hostname);
  if (!allowed) return; // firestore.googleapis.com dll. lewat jaringan biasa
  e.respondWith(staleWhileRevalidate(req));
});

// tampilkan cache dulu (cepat & offline), sambil memperbarui cache di belakang layar
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  return (await network) || (req.mode === 'navigate' ? cache.match('/index.html') : Response.error());
}
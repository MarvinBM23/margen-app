const CACHE_NAME = 'cifra-cache-v2';
const urlsToCache = ['./', './index.html', 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js'];

self.addEventListener('install', event => {
  self.skipWaiting(); // Fuerza la instalación inmediata
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.map(key => { if (key !== CACHE_NAME) return caches.delete(key); })
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const resClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        return response;
      })
      .catch(() => caches.match(event.request)) // Si no hay internet, usa el caché
  );
});

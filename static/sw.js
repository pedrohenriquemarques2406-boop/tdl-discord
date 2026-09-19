// Service Worker para PWA TDL Discord
const CACHE_NAME = 'tdl-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through para WebSocket e requisições dinâmicas
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

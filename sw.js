/**
 * sw.js — Prompt2UI service worker
 *
 * Cache-first for app shell assets; network-first for navigations.
 * Enables offline use and installability (Android Chrome + iOS Safari Add to Home Screen).
 */

const CACHE = 'prompt2ui-v2';

const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './app/calorie-tracker.js',
  './core/db-api.js',
  './core/prompt-db.js',
  './core/prompt-crypto.js',
  './core/prompt-storage.js',
  './core/sync-engine.js',
  './core/settings-panel.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Bypass non-same-origin (Tailwind CDN, Google Fonts, OAuth, cloud APIs)
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to cached shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (!res.ok) return res;
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      });
    })
  );
});

/**
 * Sandesh 2.0 - Progressive Web App Service Worker
 * Features:
 *  - App Shell precaching for instantaneous startup
 *  - Network-First with /offline/ fallback for HTML navigation
 *  - Safe Network-Only pass-through for WebRTC, APIs, WebSockets & Auth
 *  - Stale-While-Revalidate for static assets (CSS, images, icons, fonts)
 */

const CACHE_VERSION = 'sandesh-pwa-v1.1.0';
const STATIC_CACHE = `sandesh-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `sandesh-runtime-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  '/offline/',
  '/manifest.webmanifest',
  '/static/css/custom.css',
  '/static/icons/icon-192x192.png',
  '/static/icons/icon-512x512.png',
  '/static/icons/apple-touch-icon.png',
  '/static/icons/favicon-32x32.png',
  '/static/icons/favicon.ico',
  '/static/sounds/shankha.mp3',
  '/static/sounds/shankha.ogg'
];

// ── Install: Precache Core App Shell ─────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        return cache.addAll(PRECACHE_ASSETS).catch((err) => {
          console.warn('[PWA SW] Precache warning:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activate: Clean up old caches & take immediate control ───────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== STATIC_CACHE && name !== RUNTIME_CACHE)
          .map((name) => {
            console.log('[PWA SW] Deleting obsolete cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ── Fetch: Strategic Caching Rules ──────────────────────────────
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. Only process GET requests over http/https
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) {
    return;
  }

  // 2. Range requests (audio/video streaming) bypass service worker
  if (request.headers.get('range')) {
    return;
  }

  // 3. Sensitive / Dynamic Paths: ALWAYS Network-Only (No stale caching)
  const isDynamicPath =
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/admin/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.includes('/call/') ||
    url.pathname.includes('/webrtc/') ||
    url.pathname.includes('logout') ||
    url.pathname.includes('__clerk') ||
    url.search.includes('__clerk');

  if (isDynamicPath) {
    event.respondWith(fetch(request));
    return;
  }

  // 4. Navigation Requests (Page Loads / Transitions)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .catch(async () => {
          // Device is completely offline: fallback to cached offline page
          const cache = await caches.open(STATIC_CACHE);
          const cachedOffline = await cache.match('/offline/');
          return cachedOffline || new Response('Offline - Please check your connection.', {
            status: 503,
            headers: { 'Content-Type': 'text/html' }
          });
        })
    );
    return;
  }

  // 5. Static Assets (CSS, Fonts, Images, Icons)
  const isStaticAsset =
    url.pathname.startsWith('/static/') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdn.tailwindcss.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdn.jsdelivr.net');

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, responseClone));
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 6. Default: Network with Cache Fallback
  event.respondWith(
    fetch(request)
      .catch(() => caches.match(request))
  );
});

// ── Notifications Support (For Web Push) ────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/messaging/') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/messaging/');
      }
    })
  );
});

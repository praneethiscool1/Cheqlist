// Service worker: saves the app's files on your device so it opens even with no internet.
// It does NOT run reminders in the background. Reminders are still checked by the page itself.

// If you change any app file, change this version number so phones pick up the new files.
var CACHE_NAME = 'todo-checklist-v18';

var APP_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './sortable.min.js',
  './fonts/bricolage-grotesque-latin-wght-normal.woff2',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(APP_FILES); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  // Remove caches from older versions
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
             .map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// Network first (so updates show up when you are online), saved copy when offline.
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      return response;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});

// Tapping a reminder notification brings the app to the front.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      if (list.length) return list[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

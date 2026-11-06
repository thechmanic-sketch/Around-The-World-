/* TalentTrade Meet service worker: makes the web app installable, quick to open,
 * and shows a friendly page when there's no internet.
 *
 * - Pages: always fetched fresh when online (so updates show straight away); the saved
 *   copy is only used when offline.
 * - Styles, scripts, logos: served from the saved copy and refreshed in the background.
 * - Never stored: account requests (/api/), sponsor videos, and anything from other sites
 *   (the video server, fonts).
 * When you change the site, bump VERSION so everyone gets the new files.
 */
var VERSION = 'tt-v1';
var SHELL = [
  './', 'index.html', 'meet.html', 'join.html', 'login.html', 'signup.html', 'offline.html',
  'manifest.webmanifest',
  'assets/style.css', 'assets/ads.js', 'assets/present-timer.js', 'assets/auth.js', 'assets/auth-ui.js', 'assets/pwa.js',
  'assets/tt-logo.png', 'assets/tt-mark.png', 'assets/tt-wordmark.png', 'assets/favicon.png',
  'assets/icon-192.png', 'assets/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                         // video server, fonts, etc.
  if (url.pathname.indexOf('/api/') > -1) return;                            // accounts: always live
  if (url.pathname.indexOf('/ads/videos/') > -1 || req.headers.has('range')) return; // videos stream normally

  // Pages and the ads settings: network first, saved copy when offline.
  if (req.mode === 'navigate' || /\.html$|\/$|ads\.json$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === 'navigate' ? caches.match('offline.html') : Response.error());
      });
    }));
    return;
  }

  // Styles, scripts, images: saved copy straight away, refreshed in the background.
  e.respondWith(caches.match(req).then(function (hit) {
    var fresh = fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return hit; });
    return hit || fresh;
  }));
});

/* Makes TalentTrade installable: registers the service worker and shows
 * "Install the app" buttons (any element with data-install) when the browser allows it.
 * On iPhone/iPad, where browsers don't offer an install button, elements with
 * data-install-ios explain how to add it to the home screen instead.
 */
(function () {
  'use strict';
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      var root = (document.querySelector('link[rel="manifest"]') || {}).href || 'manifest.webmanifest';
      navigator.serviceWorker.register(new URL('sw.js', root).href).catch(function () {});
    });
  }

  var installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  var deferred = null;
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    each('[data-install]', function (b) { b.hidden = false; });
  });
  window.addEventListener('appinstalled', function () {
    deferred = null;
    each('[data-install]', function (b) { b.hidden = true; });
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-install]');
    if (!b || !deferred) return;
    e.preventDefault();
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; each('[data-install]', function (x) { x.hidden = true; }); });
  });

  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.addEventListener('DOMContentLoaded', function () {
    if (ios && !installed) each('[data-install-ios]', function (el) { el.hidden = false; });
  });
})();

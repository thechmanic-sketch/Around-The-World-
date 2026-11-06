/* Around The World Meet: sponsor video ad engine.
 *
 * Everything is driven by ads/ads.json (edit it by hand or with ads/admin.html):
 *   settings.preroll  - full-screen ad before someone joins a meeting (skippable)
 *   settings.lobby    - muted, looping sponsor slot on the join screen
 *   settings.incall   - small muted corner ad during a call, on a timer
 *   ads[]             - each sponsor video, where it may run, when, and how often
 *
 * Usage:
 *   AdEngine.load('ads/ads.json').then(...)
 *   AdEngine.preroll()            -> Promise, resolves when the ad ends / is skipped
 *   AdEngine.lobby(slotEl)        -> stop()
 *   AdEngine.incall(hostEl)       -> stop()
 *   AdEngine.on(fn)               -> fn({type, adId, sponsor, placement, time})
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    trackUrl: '',
    preroll: { enabled: true, skipAfterSeconds: 5, maxPerSession: 1 },
    lobby: { enabled: true, rotateSeconds: 30 },
    incall: { enabled: true, firstAfterMinutes: 5, everyMinutes: 15, maxPerCall: 3, maxSecondsOnScreen: 30 }
  };
  var DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  var config = { settings: DEFAULTS, ads: [] };
  var listeners = [];
  var lastShown = {};

  /* ---------- small helpers ---------- */
  function merge(base, over) {
    var out = {};
    for (var k in base) out[k] = base[k];
    for (var j in over || {}) {
      out[j] = (base[j] && typeof base[j] === 'object' && !Array.isArray(base[j])) ? merge(base[j], over[j]) : over[j];
    }
    return out;
  }
  function session(key, val) {
    try {
      if (val === undefined) return Number(sessionStorage.getItem('atw-ad-' + key) || 0);
      sessionStorage.setItem('atw-ad-' + key, String(val));
    } catch (e) { return 0; }
  }
  function safeUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (/^(https?:)?\/\//i.test(u) || /^[\w.\/?#=&%-]+$/.test(u)) return u; // http(s) or a relative path; never javascript:
    return '';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function minutesOf(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  /* ---------- rules: can this ad run here, now? ---------- */
  function eligible(ad, placement, now) {
    now = now || new Date();
    if (!ad || ad.active === false || !ad.video) return false;
    if (ad.placements && ad.placements.length && ad.placements.indexOf(placement) < 0) return false;

    var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    if (ad.startDate && today < ad.startDate) return false;
    if (ad.endDate && today > ad.endDate) return false;

    if (ad.days && ad.days.length) {
      var d = DAY_NAMES[now.getDay()];
      var ok = ad.days.some(function (x) { return String(x).toLowerCase().slice(0, 3) === d; });
      if (!ok) return false;
    }
    if (ad.hours && ad.hours.length) {
      var mins = now.getHours() * 60 + now.getMinutes();
      var inRange = ad.hours.some(function (r) {
        var p = String(r).split('-'), a = minutesOf(p[0]), b = minutesOf(p[1]);
        if (a == null || b == null) return false;
        return a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b); // supports overnight, e.g. 22:00-02:00
      });
      if (!inRange) return false;
    }
    if (ad.maxViewsPerSession > 0 && session('views-' + ad.id) >= ad.maxViewsPerSession) return false;
    return true;
  }

  function pick(placement) {
    var s = config.settings;
    if (!s.enabled || !s[placement] || !s[placement].enabled) return null;
    var pool = config.ads.filter(function (a) { return eligible(a, placement); });
    if (pool.length > 1 && lastShown[placement]) {
      var fresh = pool.filter(function (a) { return a.id !== lastShown[placement]; });
      if (fresh.length) pool = fresh; // don't show the same sponsor twice in a row
    }
    if (!pool.length) return null;
    var total = pool.reduce(function (n, a) { return n + Math.max(0, Number(a.weight == null ? 1 : a.weight)); }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= Math.max(0, Number(pool[i].weight == null ? 1 : pool[i].weight));
      if (r < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /* ---------- reporting ---------- */
  function track(type, ad, placement, extra) {
    var ev = { type: type, adId: ad && ad.id, sponsor: ad && ad.sponsor, placement: placement, time: new Date().toISOString(), page: location.pathname };
    for (var k in extra || {}) ev[k] = extra[k];
    if (type === 'impression' && ad) {
      lastShown[placement] = ad.id;
      session('views-' + ad.id, session('views-' + ad.id) + 1);
    }
    listeners.forEach(function (fn) { try { fn(ev); } catch (e) {} });
    var url = config.settings.trackUrl;
    if (url) {
      try {
        var body = JSON.stringify(ev);
        if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })))) {
          fetch(url, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function () {});
        }
      } catch (e) {}
    }
  }

  /* ---------- shared pieces ---------- */
  function makeVideo(ad, opts) {
    var v = el('video');
    v.src = ad.video;
    if (ad.poster) v.poster = ad.poster;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.muted = !!opts.muted;
    v.loop = !!opts.loop;
    return v;
  }
  function makeCta(ad, placement) {
    var url = safeUrl(ad.clickUrl);
    if (!url) return null;
    var a = el('a', 'ad-cta', ad.cta || 'Learn more');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener sponsored';
    a.addEventListener('click', function () { track('click', ad, placement); });
    return a;
  }
  function label(ad) {
    var l = el('div', 'ad-label');
    l.appendChild(el('span', 'ad-tag', 'Sponsored'));
    if (ad.sponsor) l.appendChild(el('span', 'ad-sponsor', ad.sponsor));
    return l;
  }

  /* ---------- placement: pre-roll ---------- */
  function preroll() {
    var cfg = config.settings.preroll;
    if (session('preroll-count') >= (cfg.maxPerSession || Infinity)) return Promise.resolve(null);
    var ad = pick('preroll');
    if (!ad) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var done = false;
      var overlay = el('div', 'ad-preroll');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Sponsored message');
      var box = el('div', 'ad-preroll-box');
      var head = el('div', 'ad-preroll-head');
      head.appendChild(label(ad));
      head.appendChild(el('span', 'ad-note', 'Your meeting starts after this short message'));
      var frame = el('div', 'ad-frame');
      var v = makeVideo(ad, { muted: false });
      frame.appendChild(v);
      var sound = el('button', 'ad-sound', 'Tap for sound');
      sound.type = 'button';
      sound.hidden = true;
      sound.onclick = function () { v.muted = false; sound.hidden = true; };
      frame.appendChild(sound);
      var bar = el('div', 'ad-bar');
      var cta = makeCta(ad, 'preroll');
      if (cta) bar.appendChild(cta);
      var skip = el('button', 'ad-skip');
      skip.type = 'button';
      bar.appendChild(skip);
      box.appendChild(head); box.appendChild(frame); box.appendChild(bar);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      var wait = Math.max(0, Number(cfg.skipAfterSeconds) || 0), started = false, tick;
      function setSkip() {
        if (wait > 0) { skip.disabled = true; skip.textContent = 'Skip in ' + wait; }
        else { skip.disabled = false; skip.textContent = 'Skip ad ›'; }
      }
      setSkip();
      function finish(type) {
        if (done) return;
        done = true;
        clearInterval(tick); clearTimeout(stall);
        if (type) track(type, ad, 'preroll', { watchedSeconds: Math.round(v.currentTime || 0) });
        v.pause(); overlay.remove();
        resolve(ad);
      }
      skip.onclick = function () { finish('skip'); };
      v.addEventListener('playing', function () {
        if (started) return;
        started = true;
        session('preroll-count', session('preroll-count') + 1);
        track('impression', ad, 'preroll');
        tick = setInterval(function () { if (wait > 0) { wait--; setSkip(); } }, 1000);
      });
      v.addEventListener('ended', function () { finish('complete'); });
      v.addEventListener('error', function () { finish('error'); });
      // If the video can't start within 8s (slow network, blocked file), don't hold the meeting hostage.
      var stall = setTimeout(function () { if (!started) finish('error'); }, 8000);

      var p = v.play();
      if (p && p.catch) p.catch(function () { // browser blocked sound: play muted instead
        v.muted = true; sound.hidden = false;
        v.play().catch(function () { finish('error'); });
      });
    });
  }

  /* ---------- placement: lobby slot ---------- */
  function lobby(slot) {
    var cfg = config.settings.lobby, timer = null, current = null, stopped = false;
    function show() {
      if (stopped) return;
      var ad = pick('lobby');
      if (!ad) { slot.hidden = true; slot.innerHTML = ''; return; }
      if (current && current.id === ad.id && slot.firstChild) return; // only one eligible ad: keep it running
      current = ad;
      slot.innerHTML = '';
      slot.hidden = false;
      var frame = el('div', 'ad-frame');
      var rotate = Number(cfg.rotateSeconds) || 0;
      var v = makeVideo(ad, { muted: true, loop: !rotate });
      frame.appendChild(v);
      var foot = el('div', 'ad-foot');
      foot.appendChild(label(ad));
      var cta = makeCta(ad, 'lobby');
      if (cta) foot.appendChild(cta);
      slot.appendChild(frame); slot.appendChild(foot);
      var seen = false;
      v.addEventListener('playing', function () { if (!seen) { seen = true; track('impression', ad, 'lobby'); } });
      v.addEventListener('error', function () { track('error', ad, 'lobby'); slot.hidden = true; });
      if (!rotate) v.addEventListener('ended', show);
      else v.addEventListener('ended', function () { v.currentTime = 0; v.play().catch(function () {}); });
      v.play().catch(function () {});
    }
    show();
    var r = Number(cfg.rotateSeconds) || 0;
    if (r > 0) timer = setInterval(show, r * 1000);
    return function stop() {
      stopped = true; clearInterval(timer);
      var v = slot.querySelector('video'); if (v) v.pause();
      slot.innerHTML = ''; slot.hidden = true;
    };
  }

  /* ---------- placement: in-call corner ---------- */
  function incall(host) {
    var cfg = config.settings.incall, shown = 0, timers = [], card = null;
    if (!config.settings.enabled || !cfg.enabled) return function () {};

    function hide(type, ad, v) {
      if (!card) return;
      if (type) track(type, ad, 'incall', { watchedSeconds: Math.round((v && v.currentTime) || 0) });
      if (v) v.pause();
      card.remove(); card = null;
    }
    function show() {
      if (card || shown >= (cfg.maxPerCall || Infinity)) return;
      var ad = pick('incall');
      if (!ad) return;
      shown++;
      card = el('aside', 'ad-incall');
      card.setAttribute('aria-label', 'Sponsored message');
      var close = el('button', 'ad-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close sponsored message');
      var frame = el('div', 'ad-frame');
      var v = makeVideo(ad, { muted: true }); // never interrupt the conversation with sound
      frame.appendChild(v);
      var foot = el('div', 'ad-foot');
      foot.appendChild(label(ad));
      var cta = makeCta(ad, 'incall');
      if (cta) foot.appendChild(cta);
      card.appendChild(close); card.appendChild(frame); card.appendChild(foot);
      host.appendChild(card);
      var mine = card, seen = false;
      close.onclick = function () { hide('close', ad, v); };
      v.addEventListener('playing', function () { if (!seen) { seen = true; track('impression', ad, 'incall'); } });
      v.addEventListener('ended', function () { if (card === mine) hide('complete', ad, v); });
      v.addEventListener('error', function () { if (card === mine) hide('error', ad, v); });
      var limit = Number(cfg.maxSecondsOnScreen) || 0;
      if (limit > 0) timers.push(setTimeout(function () { if (card === mine) hide('complete', ad, v); }, limit * 1000));
      v.play().catch(function () { if (card === mine) hide('error', ad, v); });
    }
    var first = Math.max(0, Number(cfg.firstAfterMinutes) || 0) * 60000;
    var every = Math.max(0, Number(cfg.everyMinutes) || 0) * 60000;
    timers.push(setTimeout(function () {
      show();
      if (every > 0) timers.push(setInterval(show, every));
    }, first));
    return function stop() {
      timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
      timers = [];
      if (card) { var v = card.querySelector('video'); if (v) v.pause(); card.remove(); card = null; }
    };
  }

  /* ---------- styles (injected once so any page can use the engine) ---------- */
  function injectStyles() {
    if (document.getElementById('atw-ad-styles')) return;
    var css =
      '.ad-label{display:flex;align-items:center;gap:.5rem;font-size:.78rem;min-width:0}' +
      '.ad-tag{background:#ffd34d;color:#1a1400;font-weight:800;text-transform:uppercase;letter-spacing:.06em;font-size:.65rem;padding:.15rem .45rem;border-radius:6px}' +
      '.ad-sponsor{color:var(--text,#fff);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.ad-frame{position:relative;background:#000;border-radius:14px;overflow:hidden;aspect-ratio:16/9}' +
      '.ad-frame video{width:100%;height:100%;object-fit:contain;display:block}' +
      '.ad-cta{display:inline-block;background:var(--accent,#7c5cff);color:#fff;font-weight:700;font-size:.85rem;padding:.45rem .9rem;border-radius:999px;text-decoration:none;white-space:nowrap}' +
      '.ad-foot{display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.6rem .2rem 0}' +
      '.ad-preroll{position:fixed;inset:0;z-index:100;background:rgba(4,4,10,.94);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.ad-preroll-box{width:100%;max-width:900px}' +
      '.ad-preroll-head{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:.7rem;flex-wrap:wrap}' +
      '.ad-note{color:var(--muted,#9a9fbd);font-size:.85rem}' +
      '.ad-bar{display:flex;justify-content:flex-end;align-items:center;gap:.7rem;margin-top:.8rem}' +
      '.ad-skip{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:.55rem 1.1rem;font:inherit;font-weight:700;cursor:pointer;min-width:120px}' +
      '.ad-skip:disabled{opacity:.6;cursor:default}' +
      '.ad-sound{position:absolute;left:12px;bottom:12px;background:rgba(0,0,0,.7);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:.4rem .8rem;font:inherit;font-size:.8rem;cursor:pointer}' +
      '.ad-incall{position:absolute;right:16px;bottom:16px;width:min(300px,60%);background:var(--bg2,#0d0d18);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:16px;padding:8px;z-index:5;box-shadow:0 20px 50px -10px rgba(0,0,0,.8)}' +
      '.ad-incall .ad-frame{border-radius:10px}' +
      '.ad-incall .ad-foot{padding:.5rem .1rem 0}' +
      '.ad-incall .ad-cta{font-size:.75rem;padding:.35rem .7rem}' +
      '.ad-close{position:absolute;top:-10px;right:-10px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:#1b1b2a;color:#fff;font-size:1.1rem;line-height:1;cursor:pointer;z-index:1}';
    var s = el('style'); s.id = 'atw-ad-styles'; s.textContent = css;
    document.head.appendChild(s);
  }

  global.AdEngine = {
    load: function (url) {
      injectStyles();
      return fetch(url, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (data) { AdEngine.use(data); return config; })
        .catch(function (e) { config = { settings: merge(DEFAULTS, { enabled: false }), ads: [] }; console.warn('Ads disabled:', e.message); return config; });
    },
    use: function (data) {
      injectStyles();
      config = { settings: merge(DEFAULTS, (data && data.settings) || {}), ads: (data && data.ads) || [] };
    },
    get config() { return config; },
    eligible: eligible,
    pick: pick,
    track: track,
    preroll: preroll,
    lobby: lobby,
    incall: incall,
    on: function (fn) { listeners.push(fn); }
  };
})(window);

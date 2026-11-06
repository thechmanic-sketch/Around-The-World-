/* Shared helpers for the join, sign-up and log-in screens. */
(function (global) {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function say(kind, text, focusEl) {
    var m = $('msg');
    if (m) { m.className = 'msg show ' + kind; m.textContent = text; }
    if (focusEl) focusEl.focus();
    return false;
  }

  // Show / hide password buttons
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.show-pw');
    if (!b) return;
    var i = b.parentNode.querySelector('input');
    var showing = i.type === 'text';
    i.type = showing ? 'password' : 'text';
    b.textContent = showing ? 'Show' : 'Hide';
    b.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });

  global.AuthUI = {
    $: $,
    err: function (t, f) { return say('err', t, f); },
    ok: function (t) { return say('ok', t); },
    info: function (t) { return say('info', t); },
    clear: function () { var m = $('msg'); if (m) m.className = 'msg'; },
    fail: function (er) {
      if (er && er.code === 'not-configured') return say('info', 'Accounts aren’t switched on yet. You can still start and join meetings without an account.');
      return say('err', TTAuth.friendly(er));
    },
    busy: function (btn, text) { btn.dataset.label = btn.textContent; btn.textContent = text; btn.disabled = true; },
    done: function (btn) { if (btn.dataset.label) btn.textContent = btn.dataset.label; btn.disabled = false; },
    validEmail: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); },
    // Only allow redirects to pages on this site (stops "?next=https://evil.example" tricks).
    safeNext: function (v) { return v && /^[\w.\-]+\.html(#[\w-]*)?$/.test(v) ? v : ''; },
    rememberName: function (n) { try { if (n) localStorage.setItem('atw-name', n); } catch (e) {} },
    savedName: function () { try { return localStorage.getItem('atw-name') || ''; } catch (e) { return ''; } },
    // Checks for the account server; if there isn't one, explains and disables the buttons.
    notConfiguredNotice: function (buttons) {
      return TTAuth.load().then(function (cfg) {
        if (cfg) return cfg;
        say('info', 'Accounts aren’t switched on yet, so signing up and logging in don’t work for now. You can still start and join meetings without an account.');
        (buttons || []).forEach(function (b) { if (b) b.disabled = true; });
        return null;
      });
    }
  };
})(window);

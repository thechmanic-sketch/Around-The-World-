/* TalentTrade accounts: talks to your own account server (server/talenttrade_server.py).
 *
 * ACCOUNT_SERVER: where the account server is.
 *   ''  (default) = the same server that is showing this page. This is the normal setup:
 *        run server/talenttrade_server.py and it serves the website and the accounts together.
 *   If the page is opened somewhere without the account server (for example GitHub Pages),
 *   the screens say "accounts aren't switched on yet" and meetings keep working without accounts.
 */
(function (global) {
  'use strict';

  var ACCOUNT_SERVER = '';

  var cfgPromise = null, mePromise = null;

  function api(method, path, body) {
    return fetch(ACCOUNT_SERVER + path, {
      method: method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.message || ('HTTP ' + r.status)); e.code = data.error || ('http-' + r.status); e.status = r.status; throw e; }
        return data;
      });
    }, function () { var e = new Error('network'); e.code = 'network'; throw e; });
  }

  // Is there an account server here? Resolves to its settings, or null if not.
  function load() {
    if (!cfgPromise) {
      cfgPromise = api('GET', '/api/config').then(function (c) {
        if (!c || !c.accounts) return null;
        T.configured = true;
        T.requireLoginToHost = !!c.requireLoginToHost;
        return c;
      }).catch(function () { return null; });
    }
    return cfgPromise;
  }
  function need() {
    return load().then(function (c) { if (!c) { var e = new Error('not-configured'); e.code = 'not-configured'; throw e; } });
  }

  /* Plain-English messages for the server's error codes. */
  var MESSAGES = {
    'invalid-login': 'That email and password don’t match an account.',
    'not-confirmed': 'Please confirm your email first. Check your inbox for the link we sent.',
    'exists': 'There’s already an account with that email. Try logging in instead.',
    'weak-password': 'Please choose a password of at least 8 characters.',
    'invalid-email': 'Please enter a valid email address.',
    'missing-name': 'Please enter your name.',
    'rate-limited': 'Too many attempts. Please wait a few minutes and try again.',
    'bad-token': 'This reset link has expired or was already used. Please ask for a new one.',
    'network': 'We couldn’t reach the server. Check your internet connection.',
    'server': 'Something went wrong on our side. Please try again in a moment.'
  };
  function friendly(err) {
    return MESSAGES[err && err.code] || (err && err.message ? 'Something went wrong: ' + err.message : 'Something went wrong. Please try again.');
  }

  var T = global.TTAuth = {
    configured: false,          // becomes true once the account server answers
    requireLoginToHost: false,  // set by the server (TT_REQUIRE_LOGIN_TO_HOST)
    load: load,
    friendly: friendly,
    user: function () {
      if (!mePromise) {
        mePromise = load().then(function (c) {
          if (!c) return null;
          return api('GET', '/api/me').then(function (d) { return d.user; }).catch(function () { return null; });
        });
      }
      return mePromise;
    },
    displayName: function (u) { return u ? (u.name || (u.email ? u.email.split('@')[0] : '')) : ''; },
    signUp: function (name, email, password, role) {
      return need().then(function () { return api('POST', '/api/signup', { name: name, email: email, password: password, role: role || '' }); })
        .then(function (d) { mePromise = null; return d; }); // { needsConfirm, user? }
    },
    signIn: function (email, password) {
      return need().then(function () { return api('POST', '/api/login', { email: email, password: password }); })
        .then(function (d) { mePromise = null; return d; }); // { user }
    },
    sendReset: function (email) {
      return need().then(function () { return api('POST', '/api/forgot', { email: email }); });
    },
    resetPassword: function (token, password) {
      return need().then(function () { return api('POST', '/api/reset', { token: token, password: password }); })
        .then(function (d) { mePromise = null; return d; });
    },
    signOut: function () {
      return load().then(function (c) { if (c) return api('POST', '/api/logout', {}); }).catch(function () {})
        .then(function () { mePromise = null; });
    },
    // A meeting pass for your own Jitsi server (only if the server is set up for it).
    jitsiToken: function () {
      return load().then(function (c) {
        if (!c || !c.jitsiTokens) return null;
        return api('GET', '/api/jitsi-token').then(function (d) { return d.token; }).catch(function () { return null; });
      });
    }
  };
})(window);

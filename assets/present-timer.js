/* Around The World Meet: presentation timer.
 *
 * PresentTimer.init({ stage, button, popupHost, presets, send, name })
 *   stage      - element the big countdown is shown over (the video area)
 *   button     - toolbar button that opens the timer menu
 *   popupHost  - element the menu is placed in (positioned above the toolbar)
 *   presets    - minutes to offer, e.g. [1,2,3,4,5,6,7]
 *   send(msg)  - optional: share timer changes with everyone in the call
 *   name()     - optional: returns the local person's name, shown as "Started by …"
 * PresentTimer.receive(msg)   - apply a timer change sent by someone else
 * PresentTimer.state()        - current state, to bring late joiners up to date
 * PresentTimer.reset()        - clear everything (when leaving a call)
 */
(function (global) {
  'use strict';

  var opts, display, timeEl, labelEl, barEl, menu, tick = null, audio = null;
  var st = { status: 'idle', duration: 0, endsAt: 0, remaining: 0, by: '' };
  var warned = { minute: false, done: false };

  function fmt(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function remaining() { return st.status === 'running' ? st.endsAt - Date.now() : st.remaining; }

  /* ---------- sound: short beeps made in the browser, no files needed ---------- */
  function beep(times, freq) {
    try {
      audio = audio || new (global.AudioContext || global.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      for (var i = 0; i < times; i++) {
        var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.35;
        o.frequency.value = freq || 880;
        o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.start(t); o.stop(t + 0.3);
      }
    } catch (e) {}
  }

  /* ---------- drawing ---------- */
  function render() {
    var left = remaining();
    var active = st.status !== 'idle';
    display.hidden = !active;
    opts.button.classList.toggle('active', active);
    var btnLabel = 'Timer';
    if (active) {
      var over = left <= 0;
      timeEl.textContent = over ? '+' + fmt(-left) : fmt(left);
      labelEl.textContent = over ? "Time's up" : st.status === 'paused' ? 'Paused' : 'Presentation' + (st.by ? ' · ' + st.by : '');
      var frac = st.duration ? Math.min(1, Math.max(0, left / st.duration)) : 0;
      barEl.style.transform = 'scaleX(' + frac + ')';
      display.classList.toggle('warn', left > 15000 && left <= 60000);
      display.classList.toggle('danger', left > 0 && left <= 15000);
      display.classList.toggle('over', over);
      display.classList.toggle('paused', st.status === 'paused');
      btnLabel = over ? "Time's up" : fmt(left);

      if (st.status === 'running') {
        if (!warned.minute && st.duration > 60000 && left <= 60000 && left > 0) { warned.minute = true; beep(1, 660); }
        if (!warned.done && left <= 0) { warned.done = true; beep(3, 880); }
      }
    }
    opts.button.querySelector('span').textContent = btnLabel;
    renderMenu();
  }

  function renderMenu() {
    if (menu.hidden) return;
    var active = st.status !== 'idle';
    menu.querySelectorAll('[data-min]').forEach(function (b) {
      b.classList.toggle('sel', active && st.duration === Number(b.dataset.min) * 60000);
    });
    menu.querySelector('.pt-controls').hidden = !active;
    var pr = menu.querySelector('[data-act=pause]');
    pr.textContent = st.status === 'paused' ? 'Resume' : 'Pause';
    pr.disabled = remaining() <= 0;
  }

  function loop() {
    clearInterval(tick);
    tick = st.status === 'running' ? setInterval(render, 250) : null;
    render();
  }

  /* ---------- actions (local) ---------- */
  function apply(next, share) {
    var prevDuration = st.duration, prevStatus = st.status;
    st = next;
    if (st.status === 'idle' || st.duration !== prevDuration || (prevStatus === 'idle' && st.status === 'running')) {
      warned = { minute: false, done: false };
    }
    if (st.status === 'running' && st.endsAt - Date.now() > 60000) warned.minute = false;
    if (st.status === 'running' && st.endsAt - Date.now() <= 0) warned.done = true; // joined late: don't beep for time that already ran out
    loop();
    if (share && opts.send) {
      opts.send({ atw: 'timer', status: st.status, duration: st.duration, remaining: remaining(), by: st.by });
    }
  }
  function start(min) {
    var d = min * 60000;
    apply({ status: 'running', duration: d, endsAt: Date.now() + d, remaining: d, by: opts.name ? opts.name() : '' }, true);
  }
  function pauseResume() {
    if (st.status === 'running') apply({ status: 'paused', duration: st.duration, endsAt: 0, remaining: remaining(), by: st.by }, true);
    else if (st.status === 'paused') apply({ status: 'running', duration: st.duration, endsAt: Date.now() + st.remaining, remaining: st.remaining, by: st.by }, true);
  }
  function restart() { if (st.duration) start(st.duration / 60000); }
  function stop() { apply({ status: 'idle', duration: 0, endsAt: 0, remaining: 0, by: '' }, true); }

  /* ---------- building the UI ---------- */
  function build() {
    display = document.createElement('div');
    display.className = 'ptimer';
    display.hidden = true;
    display.setAttribute('role', 'timer');
    display.setAttribute('aria-live', 'off');
    display.innerHTML = '<div class="pt-label"></div><div class="pt-time">00:00</div><div class="pt-track"><div class="pt-bar"></div></div>';
    labelEl = display.querySelector('.pt-label');
    timeEl = display.querySelector('.pt-time');
    barEl = display.querySelector('.pt-bar');
    display.title = 'Timer controls';
    display.addEventListener('click', function () { toggleMenu(true); });
    opts.stage.appendChild(display);

    menu = document.createElement('div');
    menu.className = 'pt-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Presentation timer');
    var html = '<div class="pt-head"><strong>Presentation timer</strong><button type="button" class="pt-x" aria-label="Close">×</button></div>' +
      '<div class="pt-presets">';
    opts.presets.forEach(function (m) { html += '<button type="button" data-min="' + m + '">' + m + '<small>min</small></button>'; });
    html += '</div><div class="pt-controls" hidden>' +
      '<button type="button" data-act="pause">Pause</button>' +
      '<button type="button" data-act="restart">Restart</button>' +
      '<button type="button" data-act="stop" class="pt-stop">Stop</button></div>' +
      '<p class="pt-hint">Everyone in the call sees the countdown. It beeps at 1 minute left and when time is up.</p>';
    menu.innerHTML = html;
    opts.popupHost.appendChild(menu);

    menu.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.min) { start(Number(b.dataset.min)); toggleMenu(false); }
      else if (b.dataset.act === 'pause') pauseResume();
      else if (b.dataset.act === 'restart') restart();
      else if (b.dataset.act === 'stop') { stop(); toggleMenu(false); }
      else if (b.classList.contains('pt-x')) toggleMenu(false);
    });
    opts.button.addEventListener('click', function () { toggleMenu(menu.hidden); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggleMenu(false); });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !opts.button.contains(e.target) && !display.contains(e.target)) toggleMenu(false);
    });
  }
  function toggleMenu(open) {
    menu.hidden = !open;
    opts.button.setAttribute('aria-expanded', String(!!open));
    if (open) { beep(0); renderMenu(); } // beep(0) unlocks sound on this click without making a noise
  }

  global.PresentTimer = {
    init: function (o) {
      opts = o;
      opts.presets = opts.presets || [1, 2, 3, 4, 5, 6, 7];
      build();
      render();
    },
    receive: function (msg) {
      if (!msg || msg.atw !== 'timer') return false;
      var left = Number(msg.remaining) || 0, d = Number(msg.duration) || 0;
      if (msg.status === 'running') apply({ status: 'running', duration: d, endsAt: Date.now() + left, remaining: left, by: msg.by || '' }, false);
      else if (msg.status === 'paused') apply({ status: 'paused', duration: d, endsAt: 0, remaining: left, by: msg.by || '' }, false);
      else apply({ status: 'idle', duration: 0, endsAt: 0, remaining: 0, by: '' }, false);
      return true;
    },
    state: function () {
      return st.status === 'idle' ? null : { atw: 'timer', status: st.status, duration: st.duration, remaining: remaining(), by: st.by };
    },
    reset: function () {
      if (!opts) return;
      st = { status: 'idle', duration: 0, endsAt: 0, remaining: 0, by: '' };
      warned = { minute: false, done: false };
      toggleMenu(false);
      loop();
    }
  };
})(window);

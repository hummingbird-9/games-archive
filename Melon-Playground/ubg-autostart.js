/* ubg: Melon Playground auto-start.
 * This copy has no Melon backend, so the normal Sandbox -> Maps route never loads. The editor's own Preview
 * Mode does work offline, so we drive the menu there for the player:
 *   Editor -> Maps tab -> Create New -> Default -> eye (preview) -> Yes
 *
 * Where to click: Unity scales this game's UI by sqrt((W/1264) * (H/705)) (a width/height match of 0.5, found by
 * measuring the same button at several window shapes). Reference positions below were measured on a 1264x705 viewport and are
 * anchored to the corner/centre the button really hangs from, so the targets follow any window shape.
 *   bl = bottom-left, tl = top-left, c = centre, tw = top, spread across the full width (x is a fraction of width)
 *
 * Backs off if the player starts clicking/typing themselves; the "Start sandbox" button in the hint box re-runs it.
 */
(function () {
  'use strict';
  var REF_W = 1264, REF_H = 705;
  var STEPS = [
    ['Opening the editor', 'bl', 300, 585, 3200],
    ['Maps tab',           'tw', 0.5380, 35, 2200],
    ['Create new map',     'tl', 148, 190, 2200],
    ['Default map',        'c',  752, 345, 6500],
    ['Preview',            'bl', 270, 655, 2800],
    ['Confirm',            'c',  510, 345, 0]
  ];
  var running = false, userTookOver = false, autoDone = false;

  function canvas() { return document.getElementById('unity-canvas'); }
  function say(msg) { var s = document.getElementById('ubg-melon-status'); if (s) s.textContent = msg; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function target(rect, anchor, a, b) {
    var W = rect.width, H = rect.height, s = Math.sqrt((W / REF_W) * (H / REF_H));
    var x, y;
    if (anchor === 'bl')      { x = s * a;                         y = H - s * (REF_H - b); }
    else if (anchor === 'tl') { x = s * a;                         y = s * b; }
    else if (anchor === 'tw') { x = a * W;                         y = s * b; }
    else                      { x = W / 2 + s * (a - REF_W / 2);   y = H / 2 + s * (b - REF_H / 2); }
    return { x: rect.left + x, y: rect.top + y };
  }

  function send(c, type, x, y, down) {
    var base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: down ? 1 : 0 };
    if (window.PointerEvent && type !== 'click') {
      var p = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base);
      c.dispatchEvent(new PointerEvent(type.replace('mouse', 'pointer'), p));
    }
    c.dispatchEvent(new MouseEvent(type, base));
  }
  async function click(step) {
    var c = canvas(); if (!c) return false;
    var t = target(c.getBoundingClientRect(), step[1], step[2], step[3]);
    send(c, 'mousemove', t.x, t.y, false);
    await wait(120);
    send(c, 'mousedown', t.x, t.y, true);
    await wait(90);
    send(c, 'mouseup', t.x, t.y, false);
    send(c, 'click', t.x, t.y, false);
    return true;
  }

  async function run() {
    if (running) return;
    running = true; userTookOver = false;
    var btn = document.getElementById('ubg-melon-start'); if (btn) btn.disabled = true;
    for (var i = 0; i < STEPS.length; i++) {
      if (userTookOver) { say('Stopped: you took over. Press "Start sandbox" to try again.'); break; }
      say('Starting sandbox (' + (i + 1) + '/' + STEPS.length + '): ' + STEPS[i][0] + '...');
      await click(STEPS[i]);
      await wait(STEPS[i][4]);
    }
    if (!userTookOver) { say('Sandbox ready. Use the grid button (top left) to spawn items.'); autoDone = true; setTimeout(hideHint, 8000); }
    running = false;
    if (btn) btn.disabled = false;
  }
  function hideHint() { var e = document.getElementById('ubg-melon-hint'); if (e) e.remove(); }

  // a real (trusted) interaction means the player is driving; our synthetic events are never isTrusted
  // (only counted once the game has finished loading: the click on the site's own "Click to Play" button, and
  // any key presses while it loads, happen before there is anything in the game to take over)
  var loaded = false;
  ['mousedown', 'pointerdown', 'touchstart', 'keydown'].forEach(function (t) {
    window.addEventListener(t, function (e) { if (e.isTrusted && loaded) userTookOver = true; }, true);
  });

  window.ubgStartSandbox = function () { userTookOver = false; run(); };

  // wait for Unity to finish loading, give the main menu a moment to build, then go
  var poll = setInterval(function () {
    var bar = document.getElementById('unity-loading-bar');
    if (window.unityInstance && bar && bar.style.display === 'none') {
      clearInterval(poll);
      loaded = true;
      say('Loaded. Starting the sandbox for you...');
      setTimeout(function () { if (!autoDone && !userTookOver) run(); else if (userTookOver) say('Auto-start skipped because you started clicking. Press "Start sandbox" if you want it.'); }, 9000);
    }
  }, 500);
})();

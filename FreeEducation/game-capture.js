/*
 * game-capture.js  —  tiny same-origin helper for the Free Education admin live view.
 *
 * What it does: when the parent site (same origin) asks for a frame, it grabs the
 * game's <canvas> and sends back a small JPEG. This is the ONLY way to see WebGL /
 * Unity / canvas games, because those can't be read from outside their own page.
 *
 * It must be the FIRST script in the game's <head> so the getContext hook below runs
 * before the game creates its WebGL context. Add it with add-game-capture.ps1.
 *
 * Only responds to the same-origin parent window. Sends nothing on its own.
 */
(function () {
  "use strict";
  try {
    // Only meaningful inside an iframe on our own site.
    if (window.top === window.self) return;
  } catch (e) { /* cross-origin top: still fine to run */ }

  // 1) Keep WebGL frames readable. By default a WebGL canvas clears its buffer after
  //    each frame, so toDataURL() comes back blank. Forcing preserveDrawingBuffer
  //    keeps the last frame around so we can read it.
  try {
    var proto = HTMLCanvasElement.prototype;
    var origGetContext = proto.getContext;
    proto.getContext = function (type, attrs) {
      if (typeof type === "string" && /webgl/i.test(type)) {
        attrs = attrs || {};
        if (attrs.preserveDrawingBuffer !== true) attrs.preserveDrawingBuffer = true;
      }
      return origGetContext.call(this, type, attrs);
    };
  } catch (e) {}

  // Collect any Web Audio contexts the game creates, so "mute" can suspend them.
  var audioContexts = [];
  try {
    ["AudioContext", "webkitAudioContext"].forEach(function (name) {
      var Orig = window[name];
      if (!Orig) return;
      function Wrapped() {
        var ctx = arguments.length ? new Orig(arguments[0]) : new Orig();
        try { audioContexts.push(ctx); } catch (e) {}
        return ctx;
      }
      Wrapped.prototype = Orig.prototype;
      window[name] = Wrapped;
    });
  } catch (e) {}

  function bestCanvas() {
    var list = document.getElementsByTagName("canvas");
    var best = null, bestArea = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var w = c.width || c.clientWidth, h = c.height || c.clientHeight;
      var area = w * h;
      if (area > bestArea) { bestArea = area; best = c; }
    }
    return best;
  }

  function grabFrame(maxW) {
    try {
      var c = bestCanvas();
      if (!c) return null;
      var sw = c.width || c.clientWidth, sh = c.height || c.clientHeight;
      if (!sw || !sh) return null;
      var scale = Math.min(1, (maxW || 640) / sw);
      var tw = Math.max(1, Math.round(sw * scale)), th = Math.max(1, Math.round(sh * scale));
      var tmp = document.createElement("canvas");
      tmp.width = tw; tmp.height = th;
      var ctx = tmp.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(c, 0, 0, tw, th);
      return tmp.toDataURL("image/jpeg", 0.72); // may throw if the game drew cross-origin images without CORS
    } catch (e) {
      return null; // tainted/unreadable canvas -> parent will fall back to the thumbnail
    }
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__feGrab == null) return;
    // only answer our own parent window
    try { if (e.source && e.source !== window.parent) return; } catch (_) {}
    var img = grabFrame(d.maxW);
    try { window.parent.postMessage({ __feFrame: d.__feGrab, img: img }, "*"); } catch (_) {}
  });

  // 3) Report real input inside the game (throttled) so the parent can tell an
  //    actively-played game from one just left sitting open. No content, just a ping.
  var lastPing = 0;
  function ping() {
    var now = Date.now();
    if (now - lastPing < 4000) return; // at most once every 4s
    lastPing = now;
    try { window.parent.postMessage({ __feActive: 1 }, "*"); } catch (_) {}
  }
  ["pointerdown", "keydown", "mousemove", "touchstart", "wheel"].forEach(function (ev) {
    window.addEventListener(ev, ping, { passive: true });
  });

  // 4) Speed / freeze hack. Installed lazily only when the parent actually asks
  //    (the parent only asks for users the admin granted "game hacks"), so normal
  //    players pay no cost. Works by running the game's clock faster or slower.
  var hack = null;
  function installHack() {
    if (hack) return hack;
    var origTO = window.setTimeout.bind(window);
    var origIV = window.setInterval.bind(window);
    var origDate = Date.now.bind(Date);
    var perfOK = (typeof performance !== "undefined" && performance.now);
    var origPerf = perfOK ? performance.now.bind(performance) : origDate;
    var origRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
    var speed = 1;
    var dBase = origDate(), dV = origDate();
    var pBase = origPerf(), pV = origPerf();
    function rebase() {
      var r = origDate(); dV = dV + (r - dBase) * speed; dBase = r;
      var p = origPerf(); pV = pV + (p - pBase) * speed; pBase = p;
    }
    try { Date.now = function () { return Math.round(dV + (origDate() - dBase) * speed); }; } catch (e) {}
    try { if (perfOK) performance.now = function () { return pV + (origPerf() - pBase) * speed; }; } catch (e) {}
    if (origRAF) {
      window.requestAnimationFrame = function (cb) {
        return origRAF(function () { cb(perfOK ? performance.now() : Date.now()); });
      };
    }
    window.setTimeout = function (fn, delay) {
      var a = Array.prototype.slice.call(arguments, 2);
      var d = speed > 0 ? (delay || 0) / speed : 1e8; // speed 0 => effectively never (freeze)
      return origTO.apply(window, [fn, d].concat(a));
    };
    window.setInterval = function (fn, delay) {
      var a = Array.prototype.slice.call(arguments, 2);
      var d = speed > 0 ? (delay || 0) / speed : 1e8;
      return origIV.apply(window, [fn, d].concat(a));
    };
    hack = { setSpeed: function (s) { rebase(); speed = (typeof s === "number" && s >= 0) ? s : 1; } };
    return hack;
  }
  // --- zoom: visually scale the game (clicks still map correctly) ---
  function setZoom(z) {
    try {
      var el = document.body || document.documentElement;
      if (!el) return;
      if (z && z !== 1) { el.style.transformOrigin = "center top"; el.style.transform = "scale(" + z + ")"; }
      else { el.style.transform = ""; }
    } catch (e) {}
  }

  // --- mute: silence the game's audio (media elements + Web Audio contexts) ---
  var muted = false, muteTimer = null;
  function applyMuteTo(m) {
    var media = document.querySelectorAll("audio,video");
    for (var i = 0; i < media.length; i++) { try { media[i].muted = m; } catch (e) {} }
    for (var j = 0; j < audioContexts.length; j++) { try { m ? audioContexts[j].suspend() : audioContexts[j].resume(); } catch (e) {} }
  }
  function setMute(m) {
    muted = !!m;
    applyMuteTo(muted);
    // keep silencing audio/contexts that appear later while muted
    if (muted && !muteTimer) muteTimer = setInterval(function () { if (muted) applyMuteTo(true); }, 1500);
    if (!muted && muteTimer) { clearInterval(muteTimer); muteTimer = null; }
  }

  // --- auto-clicker: dispatch clicks at the last cursor spot (or center) ---
  var lastX = 0, lastY = 0, acTimer = null;
  window.addEventListener("pointermove", function (e) { lastX = e.clientX; lastY = e.clientY; }, { passive: true });
  function clickAt(x, y) {
    var el = document.elementFromPoint(x, y) || document.body;
    if (!el) return;
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (type) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })); } catch (e) {}
    });
  }
  function setAutoClick(on, cps) {
    if (acTimer) { clearInterval(acTimer); acTimer = null; }
    if (!on) return;
    var rate = Math.max(1, Math.min(50, cps || 10));
    acTimer = setInterval(function () {
      var x = lastX || Math.round(window.innerWidth / 2);
      var y = lastY || Math.round(window.innerHeight / 2);
      clickAt(x, y);
    }, Math.round(1000 / rate));
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__feHack == null) return;
    try { if (e.source && e.source !== window.parent) return; } catch (_) {}
    var hk = d.__feHack;
    if (typeof hk.speed === "number") installHack().setSpeed(hk.speed);
    if (typeof hk.zoom === "number") setZoom(hk.zoom);
    if (typeof hk.mute === "boolean") setMute(hk.mute);
    if (hk.autoclick && typeof hk.autoclick === "object") setAutoClick(!!hk.autoclick.on, hk.autoclick.cps);
  });
})();

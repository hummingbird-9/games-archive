(function () {
  "use strict";
  const noop = function () {};
  const callbacks = { audio: [], pause: [], resume: [] };
  const key = "hummingbird-offline-save";
  window.ytgame = {
    game: {
      firstFrameReady: noop, gameReady: noop,
      loadData: function () { return Promise.resolve(localStorage.getItem(key)); },
      saveData: function (value) { localStorage.setItem(key, value); return Promise.resolve(); }
    },
    system: {
      isAudioEnabled: function () { return true; },
      getLanguage: function () { return Promise.resolve(navigator.language || "en"); },
      onAudioEnabledChange: function (fn) { if (typeof fn === "function") callbacks.audio.push(fn); },
      onPause: function (fn) { if (typeof fn === "function") callbacks.pause.push(fn); },
      onResume: function (fn) { if (typeof fn === "function") callbacks.resume.push(fn); }
    },
    engagement: { sendScore: noop },
    health: { logError: noop, logWarning: noop },
    ads: { AdResult: { UNKNOWN: 0, SHOWED: 1, REJECTED: 3 }, requestAd: function () { return Promise.resolve(3); } }
  };
})();

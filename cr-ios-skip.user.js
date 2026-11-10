// ==UserScript==
// @name         CR iOS spoof + auto skip
// @namespace    tomculp
// @version      0.3.1
// @description  Desktop Safari spoof for crunchyroll.com plus auto Skip Intro / Skip Credits / next episode, driven by video timeupdate so it survives background throttling.
// @match        https://www.crunchyroll.com/*
// @match        https://crunchyroll.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/tnculp/userscripts/main/cr-ios-skip.user.js
// @updateURL    https://raw.githubusercontent.com/tnculp/userscripts/main/cr-ios-skip.user.js
// ==/UserScript==

// 0.3: identical logic to 0.2, ASCII only. Orion's Tampermonkey storage appears to
// mangle non-ASCII bytes on an unclean app close, which showed up as a syntax error
// on reopen. Nothing outside plain ASCII is in this file.
//
// How it works:
//   1. Platform spoof so the web player loads under a Mac Safari UA.
//   2. Waits for the <video> element and hooks its timeupdate event. Media events
//      keep firing while playback continues even when timers are throttled.
//   3. Each tick: find a visible skip button (known test ids first, then button
//      text / aria-label), click it, hold a 7s cooldown.
//   4. When the episode ends (or is within 1.5s of ending) click Next Episode,
//      falling back to the Shift+N shortcut.
//   5. Media Session handlers so lock screen controls reach the player, plus a
//      video.play() nudge on a fresh episode if autoplay stalls.
//
// Console lines start with [cr-skip].

(function () {
  'use strict';

  // 1. platform spoof
  var define = function (obj, key, value) {
    try { Object.defineProperty(obj, key, { get: function () { return value; }, configurable: true }); } catch (e) {}
  };
  define(navigator, 'platform', 'MacIntel');
  define(navigator, 'maxTouchPoints', 0);
  define(navigator, 'vendor', 'Apple Computer, Inc.');
  define(navigator, 'standalone', undefined);
  try { delete window.ontouchstart; } catch (e) {}
  try { delete document.ontouchstart; } catch (e) {}

  var log = function () {
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[cr-skip]');
    console.log.apply(console, a);
  };
  log('spoof platform=' + navigator.platform + ' touch=' + navigator.maxTouchPoints);

  // config
  var SKIP_COOLDOWN_MS = 7000;
  var END_THRESHOLD_S  = 1.5;
  var SKIP_TESTIDS = [
    'button[data-testid="skip-intro-button"]',
    'button[data-testid="skip-ending-button"]',
    'button[data-testid="skip-outro-button"]',
    'button[data-testid="skipButton"]',
    '[data-testid="skipIntroText"]',
    '[data-testid="skip-intro-icon"]',
    '[data-testid="skip-ending-icon"]',
    '[data-testid="skip-outro-icon"]'
  ];
  var SKIP_TEXT = [
    /skip\s*(opening|intro)/i,
    /skip\s*(ending|credits?|outro)/i,
    /skip\s*recap/i,
    /^skip$/i
  ];
  var NEXT_SELECTORS = [
    '[data-testid="next-episode-button"]',
    '[aria-label*="Next Episode" i]',
    '[aria-label*="next episode" i]'
  ];

  // state
  var lastSkipAt   = 0;
  var nextFiredFor = null;
  var hooked       = new WeakSet();

  var onCooldown = function () { return Date.now() - lastSkipAt < SKIP_COOLDOWN_MS; };

  // helpers
  function isPresent(btn) {
    if (!btn || btn.disabled) return false;
    if (getComputedStyle(btn).display === 'none') return false;
    var r = btn.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }

  function buttonLabel(btn) {
    return (btn.getAttribute('aria-label') || btn.textContent || '').trim();
  }

  function findSkipButton() {
    var i, el, btn;
    for (i = 0; i < SKIP_TESTIDS.length; i++) {
      el = null;
      try { el = document.querySelector(SKIP_TESTIDS[i]); } catch (e) { continue; }
      if (!el) continue;
      btn = el.tagName === 'BUTTON' ? el : el.closest('button');
      if (btn && isPresent(btn)) return btn;
    }
    var all = document.querySelectorAll('button');
    for (i = 0; i < all.length; i++) {
      btn = all[i];
      var label = buttonLabel(btn);
      var hit = false;
      for (var j = 0; j < SKIP_TEXT.length; j++) {
        if (SKIP_TEXT[j].test(label)) { hit = true; break; }
      }
      if (hit && isPresent(btn)) return btn;
    }
    return null;
  }

  function clickNextEpisode() {
    if (nextFiredFor === location.pathname) return;
    nextFiredFor = location.pathname;
    for (var i = 0; i < NEXT_SELECTORS.length; i++) {
      var btn = null;
      try { btn = document.querySelector(NEXT_SELECTORS[i]); } catch (e) { continue; }
      if (btn && isPresent(btn)) {
        log('next episode: clicked', NEXT_SELECTORS[i]);
        btn.click();
        return;
      }
    }
    log('next episode: no button, sending Shift+N');
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'N', code: 'KeyN', keyCode: 78, which: 78, shiftKey: true, bubbles: true
    }));
  }

  // 3/4. per-tick check
  function tick(video) {
    if (!video || !video.duration) return;

    if (!video.paused && !onCooldown()) {
      var btn = findSkipButton();
      if (btn) {
        var label = buttonLabel(btn);
        btn.click();
        lastSkipAt = Date.now();
        log('skipped:', JSON.stringify(label), 'at', video.currentTime.toFixed(1) + 's');
      }
    }

    var remaining = video.duration - video.currentTime;
    if (remaining >= 0 && remaining < END_THRESHOLD_S) clickNextEpisode();
  }

  // 5. media session + autoplay nudge
  function wireMediaSession(video) {
    if (!('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', function () {
        video.play().catch(function (e) { log('play() rejected', e.message); });
      });
      ms.setActionHandler('pause', function () { video.pause(); });
      ms.setActionHandler('nexttrack', function () { nextFiredFor = null; clickNextEpisode(); });
      ms.setActionHandler('seekforward',  function (d) { video.currentTime += (d.seekOffset || 10); });
      ms.setActionHandler('seekbackward', function (d) { video.currentTime -= (d.seekOffset || 10); });
      log('media session handlers set');
    } catch (e) { log('media session error', e.message); }
  }

  function nudgePlay(video) {
    var tries = 0;
    var id = setInterval(function () {
      tries++;
      if (!video.isConnected || !video.paused || tries > 10) { clearInterval(id); return; }
      if (video.readyState >= 2) {
        video.play().then(function () { log('autoplay nudge ok'); clearInterval(id); })
                    .catch(function (e) { log('autoplay nudge rejected:', e.message); });
      }
    }, 1000);
  }

  // 2. hook video elements
  function hookVideo(video) {
    if (hooked.has(video)) return;
    hooked.add(video);
    nextFiredFor = null;
    log('video hooked, src=', (video.currentSrc || video.src || '').slice(0, 60));
    video.addEventListener('timeupdate', function () { tick(video); });
    video.addEventListener('ended', function () { log('ended'); clickNextEpisode(); });
    video.addEventListener('play',  function () { log('play'); });
    video.addEventListener('pause', function () { log('pause at', video.currentTime.toFixed(1) + 's'); });
    wireMediaSession(video);
    nudgePlay(video);
  }

  function scan() {
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) hookVideo(vids[i]);
  }

  var debounce = null;
  var observer = new MutationObserver(function () {
    clearTimeout(debounce);
    debounce = setTimeout(scan, 100);
  });

  function init() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan();
    setInterval(function () { var v = document.querySelector('video'); if (v) tick(v); }, 1000);
    log('init on', location.pathname);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// ==UserScript==
// @name         CR iOS spoof + auto skip
// @namespace    tomculp
// @version      0.4
// @description  Desktop Safari spoof for crunchyroll.com plus auto Skip Intro / Skip Credits / next episode, driven by video timeupdate so it survives background throttling.
// @match        https://www.crunchyroll.com/*
// @match        https://crunchyroll.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/tnculp/userscripts/main/cr-ios-skip.user.js
// @updateURL    https://raw.githubusercontent.com/tnculp/userscripts/main/cr-ios-skip.user.js
// ==/UserScript==

// 0.4: credits skip fix. Matches any skip-like data-testid (incl. skip-credits-*
// and the reused skipIntroText), accepts div role=button controls as well as
// <button>, and clicks with a full pointer/mouse sequence.
//
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
  // Any element whose data-testid looks like a skip control. Crunchyroll has used
  // skip-intro-*, skip-ending-*, skip-outro-*, skip-credits-*, skipButton and
  // skipIntroText (the last one is reused for SKIP CREDITS / SKIP RECAP too).
  var SKIP_TESTID_RE = /skip.*(intro|opening|ending|outro|credit|recap|button|text|icon)/i;
  var SKIP_TEXT = [
    /skip\s*(opening|intro)/i,
    /skip\s*(ending|credits?|outro)/i,
    /skip\s*recap/i,
    /^skip$/i
  ];
  // Things that can be the actual clickable control.
  var CLICKABLE = 'button, [role="button"]';
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

  // The element to click for a matched node: its nearest button or role=button
  // ancestor, or the node itself if it has neither (some builds use a bare div).
  function clickTarget(el) {
    return (el.closest && el.closest(CLICKABLE)) || el;
  }

  function labelMatches(label) {
    if (!label || label.length > 40) return false;
    for (var j = 0; j < SKIP_TEXT.length; j++) {
      if (SKIP_TEXT[j].test(label)) return true;
    }
    return false;
  }

  function findSkipButton() {
    var i, el, btn;
    // 1. data-testid
    var tagged = document.querySelectorAll('[data-testid]');
    for (i = 0; i < tagged.length; i++) {
      el = tagged[i];
      if (!SKIP_TESTID_RE.test(el.getAttribute('data-testid') || '')) continue;
      btn = clickTarget(el);
      if (isPresent(btn)) return btn;
    }
    // 2. aria-label / text on buttons and role=button elements
    var all = document.querySelectorAll(CLICKABLE);
    for (i = 0; i < all.length; i++) {
      btn = all[i];
      if (labelMatches(buttonLabel(btn)) && isPresent(btn)) return btn;
    }
    return null;
  }

  // React handlers sometimes ignore a bare .click() on non-button elements, so
  // send a full pointer/mouse sequence at the element's centre as well.
  function realClick(el) {
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
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
        var label = buttonLabel(btn) || btn.getAttribute('data-testid') || btn.tagName;
        realClick(btn);
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

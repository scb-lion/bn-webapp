/* Human gate — a self-built "slide to verify" captcha with a SHA-256
   proof-of-work, verified at the edge by /middleware.js via /__gate/*.

   It blocks the page's form until the visitor slides the handle to the end.
   While they get ready, the browser quietly solves a small proof-of-work so a
   bot has to burn real CPU per attempt. On success the edge sets a short-lived,
   httpOnly "human pass" cookie that /api/auth/login then requires.

   DEV BYPASS (so Playwright / local E2E is never blocked): on localhost this
   script does nothing. Append ?gate=force to preview the overlay locally. */
(function () {
  'use strict';

  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  var forced = /(?:^|[?&])gate=force(?:&|$)/.test(location.search);
  if (isLocal && !forced) return; // dev: no captcha, E2E runs clean

  // Recently verified in this browser? Skip the overlay. We store slightly less
  // than the cookie's lifetime so we re-verify before the server pass expires.
  var UNTIL_KEY = 'nw_human_until';
  try {
    var until = parseInt(localStorage.getItem(UNTIL_KEY) || '0', 10);
    if (until && until > Date.now()) return;
  } catch (e) {}

  // ---------- proof-of-work ----------
  var powResolve, powReject;
  var powPromise = new Promise(function (res, rej) { powResolve = res; powReject = rej; });
  var challenge = null; // {challenge, ts, sig, bits}

  function hex(buf) {
    var v = new Uint8Array(buf), s = '';
    for (var i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0');
    return s;
  }
  function leadingZeroBits(buf) {
    var v = new Uint8Array(buf), bits = 0;
    for (var i = 0; i < v.length; i++) {
      var b = v[i];
      if (b === 0) { bits += 8; continue; }
      for (var m = 7; m >= 0; m--) { if ((b >> m) & 1) return bits; bits++; }
      break;
    }
    return bits;
  }

  var enc = new TextEncoder();
  async function solve(ch, bits) {
    var nonce = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      var digest = await crypto.subtle.digest('SHA-256', enc.encode(ch + ':' + nonce));
      if (leadingZeroBits(digest) >= bits) return nonce;
      nonce++;
      if ((nonce & 511) === 0) await new Promise(function (r) { setTimeout(r, 0); }); // keep UI alive
    }
  }

  async function fetchChallengeAndSolve() {
    var res = await fetch('/__gate/challenge', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('challenge');
    challenge = await res.json();
    return await solve(challenge.challenge, challenge.bits);
  }

  function startPow() {
    powPromise = new Promise(function (res, rej) { powResolve = res; powReject = rej; });
    fetchChallengeAndSolve().then(function (n) { powResolve(n); }, function (e) { powReject(e); });
  }

  // ---------- overlay UI ----------
  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  var overlay, track, handle, fill, label, startX = 0, dragging = false, maxX = 0, tStart = 0, busy = false;

  function build() {
    overlay = el('div', 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(20,28,34,.55);backdrop-filter:blur(4px);' +
      'font-family:"InterVariable","Inter","Helvetica Neue",Arial,sans-serif;');

    var card = el('div', 'width:min(92vw,380px);background:#fff;border-radius:16px;padding:28px 24px;' +
      'box-shadow:0 24px 70px rgba(0,0,0,.28);text-align:center;');

    var title = el('div', 'font-size:16px;font-weight:600;color:#1e2528;margin-bottom:6px;', 'Verify you’re human');
    var sub = el('div', 'font-size:13px;color:#707070;margin-bottom:20px;line-height:18px;',
      'Slide the handle all the way to the right to continue.');

    track = el('div', 'position:relative;height:48px;border-radius:10px;background:#eef1f3;' +
      'border:1px solid #d7dde1;overflow:hidden;user-select:none;touch-action:none;');
    fill = el('div', 'position:absolute;inset:0 auto 0 0;width:0;background:#dbeafe;');
    label = el('div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'font-size:13px;color:#55636b;pointer-events:none;', 'Slide to verify →');
    handle = el('div', 'position:absolute;top:3px;left:3px;width:42px;height:40px;border-radius:8px;' +
      'background:#006ee4;color:#fff;display:flex;align-items:center;justify-content:center;' +
      'cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,.25);touch-action:none;');
    handle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

    track.appendChild(fill); track.appendChild(label); track.appendChild(handle);
    card.appendChild(title); card.appendChild(sub); card.appendChild(track);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    handle.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('resize', function () { maxX = track.clientWidth - handle.offsetWidth - 6; });
    maxX = track.clientWidth - handle.offsetWidth - 6;
  }

  function setX(x) {
    x = Math.max(0, Math.min(maxX, x));
    handle.style.left = (3 + x) + 'px';
    fill.style.width = (3 + x + handle.offsetWidth) + 'px';
    return x;
  }

  function onDown(e) {
    if (busy) return;
    dragging = true; startX = e.clientX - (parseFloat(handle.style.left) || 3);
    tStart = Date.now(); handle.style.cursor = 'grabbing';
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function onMove(e) {
    if (!dragging) return;
    var x = setX(e.clientX - startX);
    if (x >= maxX - 2) complete();
  }
  function onUp() {
    if (!dragging || busy) return;
    dragging = false; handle.style.cursor = 'grab';
    if ((parseFloat(handle.style.left) || 3) < maxX + 1) reset(); // didn't reach the end
  }

  function reset() {
    if (busy) return;
    setX(0); label.textContent = 'Slide to verify →'; label.style.color = '#55636b';
    fill.style.background = '#dbeafe';
  }

  async function complete() {
    if (busy) return;
    busy = true; dragging = false; setX(maxX);
    label.textContent = 'Verifying…'; label.style.color = '#006ee4';
    var elapsed = Date.now() - tStart;
    try {
      var nonce = await powPromise; // finished (or finishes) in the background
      var res = await fetch('/__gate/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge: challenge.challenge, ts: challenge.ts, sig: challenge.sig,
          nonce: nonce, elapsed: elapsed,
        }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || 'verify');
      // Success — remember locally (a hair under the cookie TTL) and drop the overlay.
      try { localStorage.setItem(UNTIL_KEY, String(Date.now() + Math.max(0, (data.ttlMs || 0) - 15 * 60 * 1000))); } catch (e) {}
      fill.style.background = '#c9f0d2'; label.textContent = 'Verified ✓'; label.style.color = '#1a7f37';
      handle.style.background = '#1a7f37';
      setTimeout(function () { overlay.remove(); }, 500);
    } catch (e) {
      label.textContent = 'Please try again'; label.style.color = '#b3271e';
      fill.style.background = '#fdecea';
      startPow(); // fresh challenge for the retry
      setTimeout(function () { busy = false; reset(); }, 900);
    }
  }

  function init() { build(); startPow(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// Edge Middleware — runs on Vercel's Edge network BEFORE any request reaches a
// static page or a serverless function. It does NOT count against the Hobby
// plan's 12-function limit. Responsibilities:
//
//   1. Bot / headless redirect — crawler, scanner, and automation User-Agents
//      (and empty UAs) are bounced to google.com.
//   2. Server-side interstitial gate — an unverified visitor NEVER receives the
//      real page HTML. Middleware serves a neutral "security check" page (inline
//      slide-to-verify + SHA-256 proof-of-work) instead. Only after the visitor
//      solves it (setting a signed httpOnly nw_human cookie) does the real page
//      get served on reload. This hides page content, metadata, and routes.
//   3. Route-bundle gate — /js/*.js (which reveals API routes) is withheld from
//      unverified visitors too.
//   4. Login enforcement — POST /api/auth/login|otp requires verification or a
//      live session, so bots can't hit the login API directly.
//   5. Headless blocking — the interstitial reports automation signals
//      (navigator.webdriver, ChromeDriver/Puppeteer/Playwright globals, cdc_
//      props); /__gate/verify rejects them, on top of the UA redirect.
//
// Dev bypass: this file only runs on Vercel. The local scripts/dev-server.js
// never loads it, so localhost (and Playwright E2E) gets the real pages with no
// gate. GATE_DISABLED=1 also fully disables the gate on any deployment.
//
// HMAC secret = the existing JWT_SECRET (no new env var).

export const config = {
  matcher: [
    // Pages + /__gate + /api (excludes /assets, infra, and files with an extension)
    '/((?!assets/|_vercel/|favicon|.*\\.[a-zA-Z0-9]+$).*)',
    // Also gate the route-revealing script bundles
    '/js/:path*',
  ],
};

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const HUMAN_COOKIE = 'nw_human';
const SESSION_COOKIE = 'nw_session';
const CHALLENGE_TTL_MS = 2 * 60 * 1000;      // a challenge is solvable for 2 min
const HUMAN_TTL_MS = 2 * 60 * 60 * 1000;     // a solved pass is good for 2 hours
const POW_BITS = 13;                          // proof-of-work difficulty (leading zero bits)
const MIN_SOLVE_MS = 250;                     // a real drag takes longer than this

// UA signatures treated as bots/automation → redirected. Broad on purpose
// (search engines included; robots.txt already blocks indexing).
const BOT_RE = new RegExp(
  [
    'bot', 'crawl', 'spider', 'slurp', 'mediapartners', 'bingpreview', 'facebookexternalhit',
    'curl', 'wget', 'libwww', 'httpclient', 'okhttp', 'go-http-client', 'java/', 'python',
    'ruby', 'perl', 'php', 'axios', 'node-fetch', 'got ', 'winhttp', 'restsharp',
    'scrapy', 'httrack', 'wpscan', 'nikto', 'sqlmap', 'nuclei', 'masscan', 'nmap', 'zgrab',
    'censys', 'shodan', 'expanse', 'paloalto', 'netcraft', 'semrush', 'ahrefs', 'mj12',
    'dotbot', 'petalbot', 'bytespider', 'dataforseo', 'scan',
    // headless / automation
    'headless', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'webdriver',
    'electron', 'cypress', 'lighthouse', 'chrome-lighthouse', 'splash', 'prerender',
  ].join('|'),
  'i'
);

// ---------- crypto helpers (Web Crypto / Edge runtime) ----------

const enc = new TextEncoder();

async function hmacHex(data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function sign(payload) { return payload + '.' + (await hmacHex(payload)); }

async function verifySigned(value) {
  if (!value || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  return safeEqual(value.slice(dot + 1), await hmacHex(payload)) ? payload : null;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function leadingZeroBits(bytes) {
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) { bits += 8; continue; }
    for (let m = 7; m >= 0; m--) { if ((b >> m) & 1) return bits; bits++; }
    break;
  }
  return bits;
}

async function powOk(challenge, nonce, bits) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(challenge + ':' + nonce)));
  return leadingZeroBits(hash) >= bits;
}

// ---------- cookies / responses ----------

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

async function humanCookieValid(cookies) {
  const payload = await verifySigned(cookies[HUMAN_COOKIE]);
  if (!payload) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

// ---------- the interstitial page (neutral: no brand, no links, no real meta) ----------

const INTERSTITIAL = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Security check</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#0f1720;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1e2528}
.card{width:min(92vw,380px);background:#fff;border-radius:16px;padding:30px 26px;
box-shadow:0 24px 70px rgba(0,0,0,.4);text-align:center}
.h{font-size:16px;font-weight:600;margin:0 0 6px}
.s{font-size:13px;color:#707070;margin:0 0 22px;line-height:18px}
.track{position:relative;height:48px;border-radius:10px;background:#eef1f3;border:1px solid #d7dde1;overflow:hidden;user-select:none;touch-action:none}
.fill{position:absolute;inset:0 auto 0 0;width:0;background:#dbeafe}
.lbl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:#55636b;pointer-events:none}
.hand{position:absolute;top:3px;left:3px;width:42px;height:40px;border-radius:8px;background:#006ee4;color:#fff;display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,.25);touch-action:none}
.foot{margin-top:16px;font-size:11px;color:#9aa4ab}
</style></head><body>
<div class="card">
<p class="h">Confirm you&rsquo;re human</p>
<p class="s">Slide the handle to the right to continue.</p>
<div class="track" id="t">
<div class="fill" id="f"></div>
<div class="lbl" id="l">Slide to verify &rarr;</div>
<div class="hand" id="h"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>
</div>
<div class="foot">Protected access</div>
</div>
<script>
(function(){
  var enc=new TextEncoder(),challenge=null,powP=null,powRes,powRej,busy=false;
  var t=document.getElementById('t'),f=document.getElementById('f'),l=document.getElementById('l'),h=document.getElementById('h');
  var dragging=false,startX=0,maxX=0,tStart=0;
  function hb(buf){var v=new Uint8Array(buf),b=0;for(var i=0;i<v.length;i++){var x=v[i];if(x===0){b+=8;continue;}for(var m=7;m>=0;m--){if((x>>m)&1)return b;b++;}break;}return b;}
  async function solve(ch,bits){var n=0;while(true){var d=await crypto.subtle.digest('SHA-256',enc.encode(ch+':'+n));if(hb(d)>=bits)return n;n++;if((n&511)===0)await new Promise(function(r){setTimeout(r,0);});}}
  function startPow(){powP=new Promise(function(res,rej){powRes=res;powRej=rej;});fetch('/__gate/challenge',{headers:{Accept:'application/json'}}).then(function(r){return r.json();}).then(function(c){challenge=c;return solve(c.challenge,c.bits);}).then(function(n){powRes(n);},function(e){powRej(e);});}
  function signals(){
    var a=!!(window.__playwright||window.__puppeteer||window.__nightmare||window._phantom||window.callPhantom||window.domAutomation||window.domAutomationController||window.__webdriver_evaluate||window.__selenium_evaluate||window.__fxdriver_evaluate);
    try{for(var k in document){if(k.indexOf('cdc_')===0||k.indexOf('$cdc_')===0){a=true;break;}}}catch(e){}
    return {webdriver:navigator.webdriver===true,automation:a,hc:navigator.hardwareConcurrency||0,langs:(navigator.languages||[]).length,plugins:(navigator.plugins||[]).length,ua:navigator.userAgent||''};
  }
  function measure(){maxX=t.clientWidth-h.offsetWidth-6;}
  function setX(x){x=Math.max(0,Math.min(maxX,x));h.style.left=(3+x)+'px';f.style.width=(3+x+h.offsetWidth)+'px';return x;}
  function reset(){if(busy)return;setX(0);l.textContent='Slide to verify →';l.style.color='#55636b';f.style.background='#dbeafe';}
  async function done(){
    if(busy)return;busy=true;dragging=false;setX(maxX);l.textContent='Verifying…';l.style.color='#006ee4';
    var elapsed=Date.now()-tStart;
    try{
      var nonce=await powP;
      var r=await fetch('/__gate/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge:challenge.challenge,ts:challenge.ts,sig:challenge.sig,nonce:nonce,elapsed:elapsed,signals:signals()})});
      var d=await r.json().catch(function(){return{};});
      if(!r.ok||!d.ok)throw new Error(d.error||'verify');
      f.style.background='#c9f0d2';l.textContent='Verified ✓';l.style.color='#1a7f37';h.style.background='#1a7f37';
      setTimeout(function(){location.reload();},450);
    }catch(e){l.textContent='Please try again';l.style.color='#b3271e';f.style.background='#fdecea';startPow();setTimeout(function(){busy=false;reset();},900);}
  }
  h.addEventListener('pointerdown',function(e){if(busy)return;dragging=true;startX=e.clientX-(parseFloat(h.style.left)||3);tStart=Date.now();h.style.cursor='grabbing';try{h.setPointerCapture(e.pointerId);}catch(x){}});
  window.addEventListener('pointermove',function(e){if(!dragging)return;var x=setX(e.clientX-startX);if(x>=maxX-2)done();});
  window.addEventListener('pointerup',function(){if(!dragging||busy)return;dragging=false;h.style.cursor='grab';if((parseFloat(h.style.left)||3)<maxX+1)reset();});
  window.addEventListener('resize',measure);
  measure();startPow();
})();
</script>
</body></html>`;

// ---------- middleware entrypoint ----------

export default async function middleware(request) {
  if (process.env.GATE_DISABLED === '1') return; // kill-switch

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const cookies = parseCookies(request.headers.get('cookie'));
  const ua = request.headers.get('user-agent') || '';

  // 1) Bot / headless / empty UA → google (covers pages, /__gate, /js, /api).
  if (!ua || ua.length < 8 || BOT_RE.test(ua)) {
    return Response.redirect('https://www.google.com/', 302);
  }

  // 2) Gate endpoints — served entirely here, no serverless function.
  if (path === '/__gate/challenge') {
    const challenge = randomHex(16);
    const ts = Date.now();
    const sig = await hmacHex(challenge + '.' + ts);
    return json({ challenge, ts, sig, bits: POW_BITS });
  }
  if (path === '/__gate/verify') {
    if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const { challenge, ts, sig, nonce, elapsed, signals } = body || {};
    if (!challenge || !ts || !sig || nonce === undefined) return json({ ok: false, error: 'Incomplete' }, 400);
    if (!safeEqual(String(sig), await hmacHex(challenge + '.' + ts))) return json({ ok: false, error: 'Invalid challenge' }, 400);
    if (Date.now() - Number(ts) > CHALLENGE_TTL_MS || Number(ts) > Date.now() + 5000) return json({ ok: false, error: 'Challenge expired' }, 400);
    if (!(await powOk(String(challenge), String(nonce), POW_BITS))) return json({ ok: false, error: 'Proof of work failed' }, 400);
    // Headless / automation block.
    if (signals && (signals.webdriver === true || signals.automation === true)) return json({ ok: false, error: 'Automation detected' }, 400);
    if (elapsed !== undefined && Number(elapsed) < MIN_SOLVE_MS) return json({ ok: false, error: 'Too fast' }, 400);
    const pass = await sign(String(Date.now() + HUMAN_TTL_MS));
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json({ ok: true, ttlMs: HUMAN_TTL_MS }, 200, {
      'set-cookie': `${HUMAN_COOKIE}=${encodeURIComponent(pass)}; Path=/; Max-Age=${Math.floor(HUMAN_TTL_MS / 1000)}; HttpOnly;${secure} SameSite=Lax`,
    });
  }

  const verified = !!cookies[SESSION_COOKIE] || (await humanCookieValid(cookies));

  // 3) Route-revealing bundles: withhold from unverified visitors.
  if (path.startsWith('/js/')) {
    return verified ? undefined : new Response('Not Found', { status: 404 });
  }

  // 4) Login API enforcement.
  if (path === '/api/auth/login' || path === '/api/auth/otp') {
    if (method === 'POST' && !verified) {
      return json({ error: 'Verification required. Please refresh and complete the human check.' }, 403);
    }
    return;
  }
  if (path.startsWith('/api/')) return; // other APIs continue (they enforce their own auth)

  // 5) Server-side interstitial: withhold the real page HTML until verified.
  const dest = request.headers.get('sec-fetch-dest');
  const accept = request.headers.get('accept') || '';
  const isDocument = dest === 'document' || (method === 'GET' && accept.includes('text/html'));
  if (isDocument && !verified) {
    return html(INTERSTITIAL);
  }

  return; // verified, or a non-document sub-request → real content
}

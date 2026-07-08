// Edge Middleware — runs on Vercel's Edge network BEFORE any request reaches a
// static page or a serverless function. It does NOT count against the Hobby
// plan's 12-function limit, so all of the following lives here for free:
//
//   1. Bot redirect     — any crawler/scanner User-Agent is bounced to google.com.
//   2. Human gate        — a self-built "slide to verify" + proof-of-work captcha,
//                          issued and verified entirely here via the virtual
//                          /__gate/* paths (no serverless function consumed).
//   3. Login enforcement — POST /api/auth/login|otp requires a valid human pass
//                          (or an existing session), so bots can't reach the
//                          login API without solving the slider first.
//
// Dev bypass: this file only runs on Vercel. The local scripts/dev-server.js
// never loads it, so localhost (and Playwright E2E) is unaffected. A
// GATE_DISABLED=1 env var also fully disables the gate on any deployment.
//
// The HMAC secret is the same JWT_SECRET the API already uses — no new env var.

export const config = {
  // Run on everything EXCEPT static assets and files with an extension
  // (robots.txt, sitemap.xml, *.js, *.css, images…). Those are served directly.
  matcher: ['/((?!assets/|_vercel/|favicon|.*\\.[a-zA-Z0-9]+$).*)'],
};

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const HUMAN_COOKIE = 'nw_human';
const SESSION_COOKIE = 'nw_session';
const CHALLENGE_TTL_MS = 2 * 60 * 1000;      // a challenge is solvable for 2 min
const HUMAN_TTL_MS = 2 * 60 * 60 * 1000;     // a solved pass is good for 2 hours
const POW_BITS = 13;                          // proof-of-work difficulty (leading zero bits)

// User-Agent signatures we treat as bots. Deliberately broad — the user asked to
// redirect ALL bots (search engines included; robots.txt already blocks indexing).
const BOT_RE = new RegExp(
  [
    'bot', 'crawl', 'spider', 'slurp', 'mediapartners', 'bingpreview', 'facebookexternalhit',
    'curl', 'wget', 'libwww', 'httpclient', 'okhttp', 'go-http-client', 'java/', 'python',
    'ruby', 'perl', 'php', 'axios', 'node-fetch', 'got ', 'winhttp', 'restsharp',
    'scrapy', 'httrack', 'wpscan', 'nikto', 'sqlmap', 'nuclei', 'masscan', 'nmap', 'zgrab',
    'censys', 'shodan', 'expanse', 'paloalto', 'netcraft', 'semrush', 'ahrefs', 'mj12',
    'dotbot', 'petalbot', 'bytespider', 'dataforseo', 'headlesschrome', 'phantomjs',
    'puppeteer', 'playwright', 'selenium', 'scan',
  ].join('|'),
  'i'
);

// ---------- small crypto helpers (Web Crypto / Edge runtime) ----------

const enc = new TextEncoder();

async function hmacHex(data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish string compare.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function sign(payload) {
  return payload + '.' + (await hmacHex(payload));
}

async function verifySigned(value) {
  if (!value || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  return safeEqual(sig, await hmacHex(payload)) ? payload : null;
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

// ---------- cookie helpers ----------

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

// ---------- middleware entrypoint ----------

export default async function middleware(request) {
  if (process.env.GATE_DISABLED === '1') return; // kill-switch: pass everything through

  const url = new URL(request.url);
  const path = url.pathname;
  const cookies = parseCookies(request.headers.get('cookie'));

  // 1) Captcha gate endpoints — handled entirely here, no serverless function.
  if (path === '/__gate/challenge') {
    const challenge = randomHex(16);
    const ts = Date.now();
    const sig = await hmacHex(challenge + '.' + ts);
    return json({ challenge, ts, sig, bits: POW_BITS });
  }

  if (path === '/__gate/verify') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const { challenge, ts, sig, nonce } = body || {};
    if (!challenge || !ts || !sig || nonce === undefined) return json({ error: 'Incomplete' }, 400);
    // (a) challenge is genuinely one we issued and (b) still fresh
    const expectSig = await hmacHex(challenge + '.' + ts);
    if (!safeEqual(String(sig), expectSig)) return json({ ok: false, error: 'Invalid challenge' }, 400);
    if (Date.now() - Number(ts) > CHALLENGE_TTL_MS || Number(ts) > Date.now() + 5000) {
      return json({ ok: false, error: 'Challenge expired' }, 400);
    }
    // (c) proof-of-work actually solved
    if (!(await powOk(String(challenge), String(nonce), POW_BITS))) {
      return json({ ok: false, error: 'Proof of work failed' }, 400);
    }
    // Issue the signed, httpOnly human pass.
    const pass = await sign(String(Date.now() + HUMAN_TTL_MS));
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json({ ok: true, ttlMs: HUMAN_TTL_MS }, 200, {
      'set-cookie': `${HUMAN_COOKIE}=${encodeURIComponent(pass)}; Path=/; Max-Age=${Math.floor(HUMAN_TTL_MS / 1000)}; HttpOnly;${secure} SameSite=Lax`,
    });
  }

  // 2) Bot redirect — any scanner/crawler UA (or empty UA) goes to google.com.
  const ua = request.headers.get('user-agent') || '';
  if (!ua || ua.length < 8 || BOT_RE.test(ua)) {
    return Response.redirect('https://www.google.com/', 302);
  }

  // 3) Login enforcement — the login/otp API needs a human pass or a live session.
  if (path === '/api/auth/login' || path === '/api/auth/otp') {
    if (request.method === 'POST' && !cookies[SESSION_COOKIE] && !(await humanCookieValid(cookies))) {
      return json({ error: 'Verification required. Please refresh and complete the human check.' }, 403);
    }
  }

  // Everything else continues normally.
  return;
}

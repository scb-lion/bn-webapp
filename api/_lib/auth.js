// Auth helpers: JWT session in an httpOnly cookie, plus request guards and
// small response/body utilities shared by all API routes.
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { ObjectId } = require('mongodb');
const { collections } = require('./db');

const COOKIE_NAME = 'nw_session';
// Sessions persist "for life" — they stay valid until the user explicitly logs
// out (which clears the cookie), at which point a fresh sign-in (with OTP, when
// enabled) is required again.
const MAX_AGE = 60 * 60 * 24 * 365 * 10; // ~10 years
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const isProd = process.env.NODE_ENV === 'production';

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, username: user.username },
    SECRET,
    { expiresIn: MAX_AGE }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: MAX_AGE,
    })
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, '', {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
  );
}

function getToken(req) {
  const header = req.headers.cookie || '';
  const parsed = cookie.parse(header);
  return parsed[COOKIE_NAME] || null;
}

// Returns the decoded JWT payload or null.
function getSession(req) {
  const token = getToken(req);
  if (!token) return null;
  return verifyToken(token);
}

// Loads the full, current user document for the session (verifies still exists
// and is active). Returns null otherwise.
async function currentUser(req) {
  const session = getSession(req);
  if (!session) return null;
  let _id;
  try {
    _id = new ObjectId(String(session.sub));
  } catch {
    return null;
  }
  const { users } = await collections();
  const user = await users.findOne({ _id });
  if (!user || user.active === false) return null;
  return user;
}

// Guard: resolves to the user doc, or sends 401 and resolves null.
async function requireAuth(req, res) {
  const user = await currentUser(req);
  if (!user) {
    json(res, 401, { error: 'Not authenticated' });
    return null;
  }
  return user;
}

// Guard: resolves to the user doc if admin, else sends 401/403 and resolves null.
async function requireAdmin(req, res) {
  const user = await currentUser(req);
  if (!user) {
    json(res, 401, { error: 'Not authenticated' });
    return null;
  }
  if (user.role !== 'admin') {
    json(res, 403, { error: 'Admin access required' });
    return null;
  }
  return user;
}

function json(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

// Reads a JSON body. Vercel usually pre-parses req.body, but vercel dev and raw
// Node do not always, so fall back to reading the stream.
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  currentUser,
  requireAuth,
  requireAdmin,
  json,
  readBody,
};

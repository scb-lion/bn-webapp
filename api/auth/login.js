const bcrypt = require('bcryptjs');
const { collections } = require('../_lib/db');
const { signToken, setSessionCookie, json, readBody } = require('../_lib/auth');
const { sendEventEmail } = require('../_lib/email');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) {
    return json(res, 400, { error: 'Username and password are required' });
  }

  const { users } = await collections();
  const user = await users.findOne({ username });
  // Constant-ish response regardless of which check fails, to avoid user enumeration.
  const ok = user && user.active !== false && (await bcrypt.compare(password, user.passwordHash || ''));
  if (!ok) return json(res, 401, { error: 'Invalid username or password' });

  const token = signToken(user);
  setSessionCookie(res, token);

  // Best-effort sign-in alert (skipped automatically for accounts without an email).
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  await sendEventEmail(user, 'login', { when: new Date(), ip: ip, device: String(req.headers['user-agent'] || '') });

  return json(res, 200, { ok: true, role: user.role, redirect: user.role === 'admin' ? '/admin' : '/user/dashboard' });
};

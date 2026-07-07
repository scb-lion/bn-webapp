// Consolidated OTP + password-reset endpoint (kept as one function to stay under
// the hosting plan's serverless-function limit).
//   POST /api/auth/otp  { action:'verify', challengeId, code }              -> finish an OTP login
//   POST /api/auth/otp  { action:'forgot', username }                       -> email a reset code
//   POST /api/auth/otp  { action:'reset',  challengeId, code, newPassword } -> set a new password
const bcrypt = require('bcryptjs');
const { collections } = require('../_lib/db');
const { signToken, setSessionCookie, json, readBody } = require('../_lib/auth');
const { sendEventEmail, sendCode, sendPasswordChanged } = require('../_lib/email');
const { getAuthSettings, otpRequiredFor, createChallenge, verifyChallenge, maskEmail } = require('../_lib/otp');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const body = await readBody(req);
  const action = String(body.action || '');
  if (action === 'verify') return verifyLogin(req, res, body);
  if (action === 'forgot') return forgot(req, res, body);
  if (action === 'reset') return reset(req, res, body);
  return json(res, 400, { error: 'Unknown action' });
};

// Second step of an OTP login: verify the emailed code, then issue the session.
async function verifyLogin(req, res, body) {
  const challengeId = String(body.challengeId || '');
  const code = String(body.code || '').trim();
  if (!challengeId || !code) return json(res, 400, { error: 'Code is required' });

  const result = await verifyChallenge(challengeId, code, 'login');
  if (!result.ok) return json(res, result.status || 400, { error: result.error });

  const { users } = await collections();
  const user = await users.findOne({ _id: result.userId });
  if (!user || user.active === false) return json(res, 401, { error: 'Account is not available' });

  setSessionCookie(res, signToken(user));

  // Sign-in alert now fires once the session is actually granted.
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  await sendEventEmail(user, 'login', { when: new Date(), ip: ip, device: String(req.headers['user-agent'] || '') });

  return json(res, 200, { ok: true, role: user.role, redirect: user.role === 'admin' ? '/admin' : '/user/dashboard' });
}

// Start a password reset by emailing a one-time code. Self-serve reset is only
// offered when OTP is effectively enabled for the account. Because this is a demo
// app the response reports why a code wasn't sent (a real bank would keep this
// generic to avoid disclosing which usernames exist).
async function forgot(req, res, body) {
  const username = String(body.username || '').trim().toLowerCase();
  if (!username) return json(res, 400, { error: 'Username is required' });

  const { users } = await collections();
  const user = await users.findOne({ username });
  const settings = await getAuthSettings();

  if (!user || user.active === false || user.role === 'admin') {
    return json(res, 200, { ok: true, sent: false, reason: 'not-eligible' });
  }
  if (!otpRequiredFor(user, settings)) {
    return json(res, 200, { ok: true, sent: false, reason: 'otp-disabled' });
  }
  if (!user.email) {
    return json(res, 200, { ok: true, sent: false, reason: 'no-email' });
  }

  const { challengeId, code, ttlMin } = await createChallenge(user, 'reset', settings);
  await sendCode(user, 'reset', code, ttlMin); // non-fatal
  return json(res, 200, { ok: true, sent: true, challengeId: challengeId, maskedEmail: maskEmail(user.email), ttlMin: ttlMin });
}

// Complete a password reset: verify the emailed code, then set the new password.
// The user must sign in again afterwards (with OTP, when enabled).
async function reset(req, res, body) {
  const challengeId = String(body.challengeId || '');
  const code = String(body.code || '').trim();
  const newPassword = String(body.newPassword || '');
  if (!challengeId || !code) return json(res, 400, { error: 'Code is required' });
  if (newPassword.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });

  const result = await verifyChallenge(challengeId, code, 'reset');
  if (!result.ok) return json(res, result.status || 400, { error: result.error });

  const { users } = await collections();
  const user = await users.findOne({ _id: result.userId });
  if (!user || user.active === false) return json(res, 400, { error: 'Account is not available' });

  await users.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await bcrypt.hash(newPassword, 10), updatedAt: new Date() } }
  );
  await sendPasswordChanged(user); // non-fatal

  return json(res, 200, { ok: true });
}

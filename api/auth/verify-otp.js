// POST /api/auth/verify-otp  { challengeId, code }
// Second step of an OTP login: verify the emailed code, then issue the session.
const { collections } = require('../_lib/db');
const { signToken, setSessionCookie, json, readBody } = require('../_lib/auth');
const { sendEventEmail } = require('../_lib/email');
const { verifyChallenge } = require('../_lib/otp');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
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
};

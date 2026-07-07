// POST /api/auth/forgot  { username }
// Starts a password reset by emailing a one-time code. Self-serve reset is only
// offered when OTP is effectively enabled for the account (per the admin toggle
// and any per-user override). Because this is a demo app the response reports
// why a code wasn't sent (a real bank would keep this generic to avoid
// disclosing which usernames exist).
const { collections } = require('../_lib/db');
const { json, readBody } = require('../_lib/auth');
const { sendCode } = require('../_lib/email');
const { getAuthSettings, otpRequiredFor, createChallenge, maskEmail } = require('../_lib/otp');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
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
};

// POST /api/auth/reset  { challengeId, code, newPassword }
// Completes a password reset: verifies the emailed code, then sets the new
// password. The user must sign in again afterwards (with OTP, when enabled).
const bcrypt = require('bcryptjs');
const { collections } = require('../_lib/db');
const { json, readBody } = require('../_lib/auth');
const { sendPasswordChanged } = require('../_lib/email');
const { verifyChallenge } = require('../_lib/otp');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
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
};

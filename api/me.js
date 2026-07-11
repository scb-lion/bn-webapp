const bcrypt = require('bcryptjs');
const { collections } = require('./_lib/db');
const { requireAuth, resolveAccountOwner, json, readBody } = require('./_lib/auth');
const { publicUser, publicAccount, publicTxn } = require('./_lib/shape');
const { sendPasswordChanged } = require('./_lib/email');

module.exports = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'POST') return handlePost(req, res, user);

  const owner = await resolveAccountOwner(user);
  const { transactions } = await collections();
  const recent = await transactions
    .find({ userId: owner._id })
    .sort({ date: -1 })
    .limit(10)
    .toArray();

  const payload = { user: publicUser(user), transactions: recent.map(publicTxn) };
  // A joint spouse has no accounts of their own — serve the primary's live
  // accounts/balances and fill in who they're joint with.
  if (user.jointOf) {
    payload.user.accounts = (owner.accounts || []).map(publicAccount);
    if (payload.user.joint) {
      payload.user.joint.primaryName = (owner.profile && owner.profile.displayName) || owner.username;
    }
  }

  return json(res, 200, payload);
};

// POST /api/me { action:'setPassword', password } — lets a member who joined
// without a password (a joint-invite member) set one after their first sign-in.
// Once set, the account is a normal password account (OTP no longer forced).
async function handlePost(req, res, user) {
  const body = await readBody(req);
  const action = String(body.action || '');
  if (action !== 'setPassword') return json(res, 400, { error: 'Unknown action' });

  const password = String(body.password || '');
  if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });

  const passwordHash = await bcrypt.hash(password, 10);
  const { users } = await collections();
  await users.updateOne(
    { _id: user._id },
    {
      $set: { passwordHash, 'security.otpLogin': 'off', updatedAt: new Date() },
      $unset: { passwordless: '' },
    }
  );

  try { await sendPasswordChanged({ ...user, passwordHash }); } catch (e) { /* non-fatal */ }

  return json(res, 200, { ok: true });
}

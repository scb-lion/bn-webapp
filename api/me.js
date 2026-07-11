const { collections } = require('./_lib/db');
const { requireAuth, resolveAccountOwner, json } = require('./_lib/auth');
const { publicUser, publicAccount, publicTxn } = require('./_lib/shape');

module.exports = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

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

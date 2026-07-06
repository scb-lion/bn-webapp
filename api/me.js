const { collections } = require('./_lib/db');
const { requireAuth, json } = require('./_lib/auth');
const { publicUser, publicTxn } = require('./_lib/shape');

module.exports = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  const { transactions } = await collections();
  const recent = await transactions
    .find({ userId: user._id })
    .sort({ date: -1 })
    .limit(10)
    .toArray();

  return json(res, 200, {
    user: publicUser(user),
    transactions: recent.map(publicTxn),
  });
};

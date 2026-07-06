// GET /api/transactions            -> all of the caller's transactions
// GET /api/transactions?accountId= -> filtered to one account
// GET /api/transactions?id=        -> a single transaction (must belong to caller)
const { ObjectId } = require('mongodb');
const { collections } = require('./_lib/db');
const { requireAuth, json } = require('./_lib/auth');
const { publicTxn } = require('./_lib/shape');

module.exports = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const { transactions } = await collections();
  const { id, accountId } = req.query || {};

  if (id) {
    let _id;
    try { _id = new ObjectId(String(id)); } catch { return json(res, 400, { error: 'Bad id' }); }
    const txn = await transactions.findOne({ _id, userId: user._id });
    if (!txn) return json(res, 404, { error: 'Not found' });
    return json(res, 200, { transaction: publicTxn(txn) });
  }

  const query = { userId: user._id };
  if (accountId) query.accountId = String(accountId);
  const list = await transactions.find(query).sort({ date: -1 }).limit(200).toArray();
  return json(res, 200, { transactions: list.map(publicTxn) });
};

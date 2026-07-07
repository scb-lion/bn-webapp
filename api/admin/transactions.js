// POST   /api/admin/transactions        -> add a transaction to a user's account
// PATCH  /api/admin/transactions?id=     -> edit a transaction
// DELETE /api/admin/transactions?id=     -> delete a transaction
//
// Adding/editing/deleting a transaction keeps the linked account balance in sync
// (balance += signed amount). The admin can also set balances directly via
// PATCH /api/admin/user, so balances are the source of truth and transactions
// are the running history that nudges them.
const { ObjectId } = require('mongodb');
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { publicTxn } = require('../_lib/shape');
const { toCents, genRef } = require('../_lib/util');
const { sendEventEmail } = require('../_lib/email');

function oid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

// Returns signed cents given amount + optional type.
function signedCents(amount, type) {
  const cents = Math.abs(toCents(amount));
  if (type === 'debit') return -cents;
  if (type === 'credit') return cents;
  // no explicit type: respect the sign the admin typed
  return toCents(amount);
}

async function adjustBalance(users, userId, accountId, deltaCents) {
  const user = await users.findOne({ _id: userId });
  if (!user) return null;
  const accounts = (user.accounts || []).map((a) => ({ ...a }));
  const acct = accounts.find((a) => String(a.id) === String(accountId));
  if (!acct) return null;
  acct.balance = (Number(acct.balance) || 0) + deltaCents;
  await users.updateOne({ _id: userId }, { $set: { accounts, updatedAt: new Date() } });
  return acct.balance;
}

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { users, transactions } = await collections();

  if (req.method === 'POST') {
    const body = await readBody(req);
    const userId = oid(body.userId);
    if (!userId) return json(res, 400, { error: 'Bad or missing userId' });
    const user = await users.findOne({ _id: userId });
    if (!user) return json(res, 404, { error: 'User not found' });

    const accountId = String(body.accountId || (user.accounts && user.accounts[0] && user.accounts[0].id) || '');
    const acct = (user.accounts || []).find((a) => String(a.id) === accountId);
    if (!acct) return json(res, 400, { error: 'accountId does not match any of the user\'s accounts' });

    const amount = signedCents(body.amount, body.type);
    const type = amount >= 0 ? 'credit' : 'debit';
    const newBalance = await adjustBalance(users, userId, accountId, amount);

    const doc = {
      userId,
      accountId,
      ref: String(body.ref || genRef()),
      date: body.date ? new Date(body.date) : new Date(),
      description: String(body.description || '').trim() || (type === 'credit' ? 'Credit' : 'Debit'),
      counterparty: String(body.counterparty || '').trim(),
      amount,
      type,
      balanceAfter: newBalance,
    };
    const result = await transactions.insertOne(doc);
    doc._id = result.insertedId;

    // Notify the customer of the posted transaction (best-effort, never fatal).
    await sendEventEmail(user, 'transactionPosted', {
      amountCents: amount,
      description: doc.description,
      counterparty: doc.counterparty,
      accountName: (acct.name || acct.type) + ' ••' + String(acct.number || acct.id).slice(-4),
      balanceAfter: newBalance,
      date: doc.date,
    });

    return json(res, 201, { transaction: publicTxn(doc) });
  }

  const _id = oid((req.query || {}).id);

  if (req.method === 'PATCH') {
    if (!_id) return json(res, 400, { error: 'Bad or missing id' });
    const txn = await transactions.findOne({ _id });
    if (!txn) return json(res, 404, { error: 'Not found' });
    const body = await readBody(req);

    const set = {};
    if (body.description !== undefined) set.description = String(body.description).trim();
    if (body.counterparty !== undefined) set.counterparty = String(body.counterparty).trim();
    if (body.date !== undefined) set.date = new Date(body.date);

    // amount / type change -> adjust balance by the delta
    let newAmount = txn.amount;
    if (body.amount !== undefined || body.type !== undefined) {
      newAmount = signedCents(body.amount !== undefined ? body.amount : txn.amount / 100, body.type);
      const delta = newAmount - txn.amount;
      if (delta !== 0) {
        const bal = await adjustBalance(users, txn.userId, txn.accountId, delta);
        set.balanceAfter = bal;
      }
      set.amount = newAmount;
      set.type = newAmount >= 0 ? 'credit' : 'debit';
    }

    await transactions.updateOne({ _id }, { $set: set });
    const updated = await transactions.findOne({ _id });
    return json(res, 200, { transaction: publicTxn(updated) });
  }

  if (req.method === 'DELETE') {
    if (!_id) return json(res, 400, { error: 'Bad or missing id' });
    const txn = await transactions.findOne({ _id });
    if (!txn) return json(res, 404, { error: 'Not found' });
    // reverse its effect on the balance
    await adjustBalance(users, txn.userId, txn.accountId, -txn.amount);
    await transactions.deleteOne({ _id });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

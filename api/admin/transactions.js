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

  // Transfer approvals share this function (?resource=transfer) to stay within
  // the hosting plan's serverless-function limit.
  if (String((req.query || {}).resource || '') === 'transfer') {
    return handleTransfers(req, res, users, transactions);
  }

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

// ---- transfer approvals (formerly /api/admin/transfers) ----
//   GET  ?resource=transfer&status=pending           -> list transfer requests
//   POST ?resource=transfer { transferId, action }   -> approve | reject
//
// Approving a transfer is the moment money actually moves: each pending leg's
// signed amount is applied to its account balance and the leg is marked
// completed. Rejecting leaves balances untouched and marks the legs rejected.
async function handleTransfers(req, res, users, transactions) {
  if (req.method === 'GET') {
    const status = String((req.query || {}).status || 'pending');
    const legs = await transactions.find({ transferId: { $exists: true, $ne: '' }, status })
      .sort({ date: -1 }).limit(500).toArray();

    // Group legs by transferId.
    const groups = new Map();
    for (const t of legs) {
      if (!groups.has(t.transferId)) groups.set(t.transferId, []);
      groups.get(t.transferId).push(t);
    }

    // Resolve account names per user (small N).
    const userCache = new Map();
    async function acctName(userId, accountId) {
      const key = String(userId);
      if (!userCache.has(key)) userCache.set(key, await users.findOne({ _id: userId }));
      const u = userCache.get(key);
      const a = u && (u.accounts || []).find((x) => String(x.id) === String(accountId));
      return { user: u, name: a ? (a.name || a.type) : accountId, number: a ? a.number : '' };
    }

    const out = [];
    for (const [transferId, ls] of groups) {
      const debit = ls.find((l) => l.amount < 0);
      const credit = ls.find((l) => l.amount > 0);
      const primary = debit || credit;
      const amount = Math.abs(primary.amount);
      const from = debit ? await acctName(debit.userId, debit.accountId) : null;
      const to = credit ? await acctName(credit.userId, credit.accountId) : null;
      const u = (from && from.user) || (to && to.user);
      out.push({
        transferId,
        kind: primary.kind || '',
        status,
        date: primary.date ? new Date(primary.date).toISOString() : null,
        amount, // magnitude in cents
        direction: primary.amount > 0 ? 'in' : 'out',
        description: primary.description || '',
        user: u ? { id: String(u._id), username: u.username, displayName: (u.profile && (u.profile.displayName || u.profile.firstName)) || u.username } : null,
        fromAccount: from ? { name: from.name, number: from.number } : null,
        toAccount: to ? { name: to.name, number: to.number } : null,
        meta: primary.meta && typeof primary.meta === 'object' ? primary.meta : null,
      });
    }
    return json(res, 200, { transfers: out });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const transferId = String(body.transferId || '');
    const action = String(body.action || '');
    if (!transferId) return json(res, 400, { error: 'Missing transferId' });
    if (action !== 'approve' && action !== 'reject') return json(res, 400, { error: 'action must be approve or reject' });

    const legs = await transactions.find({ transferId, status: 'pending' }).toArray();
    if (!legs.length) return json(res, 404, { error: 'No pending transfer found (already handled?)' });

    // Summarize the transfer for the customer notification.
    const debit = legs.find((l) => l.amount < 0);
    const credit = legs.find((l) => l.amount > 0);
    const primary = debit || credit;
    const emailData = {
      kind: primary.kind || '',
      meta: primary.meta || {},
      amountCents: Math.abs(primary.amount),
      direction: primary.amount > 0 ? 'in' : 'out',
      transferId,
    };
    const owner = await users.findOne({ _id: primary.userId });

    if (action === 'reject') {
      await transactions.updateMany({ transferId, status: 'pending' }, { $set: { status: 'rejected' } });
      await sendEventEmail(owner, 'transferRejected', emailData);
      return json(res, 200, { ok: true, status: 'rejected' });
    }

    // approve: apply each leg to its account balance, then mark completed.
    for (const leg of legs) {
      const newBalance = await adjustBalance(users, leg.userId, leg.accountId, leg.amount);
      await transactions.updateOne(
        { _id: leg._id },
        { $set: { status: 'completed', balanceAfter: newBalance, date: leg.date || new Date() } }
      );
    }
    await sendEventEmail(owner, 'transferApproved', emailData);
    return json(res, 200, { ok: true, status: 'completed' });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

// GET  /api/admin/transfers?status=pending  -> list transfer requests (default pending)
// POST /api/admin/transfers  { transferId, action:'approve'|'reject' }
//
// Approving a transfer is the moment money actually moves: each pending leg's
// signed amount is applied to its account balance and the leg is marked
// completed. Rejecting leaves balances untouched and marks the legs rejected.
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { sendEventEmail } = require('../_lib/email');

// Apply a signed delta to one account of one user; returns the new balance (cents).
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
};

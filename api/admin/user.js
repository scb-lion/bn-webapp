// GET    /api/admin/user?id=  -> one user + their transactions (admin only)
// PATCH  /api/admin/user?id=  -> update profile, email, role, active, password, accounts/balances
// DELETE /api/admin/user?id=  -> delete user and their transactions
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { publicUser, publicTxn } = require('../_lib/shape');
const { toCents, genAccountId } = require('../_lib/util');

function oid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const _id = oid((req.query || {}).id);
  if (!_id) return json(res, 400, { error: 'Bad or missing id' });

  const { users, transactions } = await collections();

  if (req.method === 'GET') {
    const user = await users.findOne({ _id });
    if (!user) return json(res, 404, { error: 'Not found' });
    const txns = await transactions.find({ userId: _id }).sort({ date: -1 }).toArray();
    return json(res, 200, { user: publicUser(user), transactions: txns.map(publicTxn) });
  }

  if (req.method === 'PATCH') {
    const user = await users.findOne({ _id });
    if (!user) return json(res, 404, { error: 'Not found' });
    const body = await readBody(req);
    const set = { updatedAt: new Date() };

    if (body.email !== undefined) set.email = String(body.email).trim();
    if (body.role !== undefined) set.role = body.role === 'admin' ? 'admin' : 'user';
    if (body.active !== undefined) set.active = !!body.active;

    // profile fields (merge onto existing)
    const profile = { ...(user.profile || {}) };
    for (const key of ['firstName', 'displayName', 'photoUrl', 'phone', 'address']) {
      if (body[key] !== undefined) profile[key] = String(body[key]).trim();
    }
    set.profile = profile;

    // password change
    if (body.password) {
      if (String(body.password).length < 6) {
        return json(res, 400, { error: 'password must be at least 6 characters' });
      }
      set.passwordHash = await bcrypt.hash(String(body.password), 10);
    }

    // accounts / balances — full replace when provided
    if (Array.isArray(body.accounts)) {
      set.accounts = body.accounts.map((a) => ({
        id: String(a.id || a.number || genAccountId()),
        type: String(a.type || 'Checking'),
        number: String(a.number || a.id || genAccountId()),
        name: String(a.name || a.type || 'Checking'),
        balance: toCents(a.balance),
      }));
    }

    await users.updateOne({ _id }, { $set: set });
    const updated = await users.findOne({ _id });
    return json(res, 200, { user: publicUser(updated) });
  }

  if (req.method === 'DELETE') {
    if (String(_id) === String(admin._id)) {
      return json(res, 400, { error: 'You cannot delete your own admin account' });
    }
    await transactions.deleteMany({ userId: _id });
    await users.deleteOne({ _id });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

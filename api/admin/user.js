// GET    /api/admin/user?id=  -> one user + their transactions (admin only)
// PATCH  /api/admin/user?id=  -> update profile, email, role, active, password, accounts/balances
// DELETE /api/admin/user?id=  -> delete user and their transactions
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { publicUser, publicTxn } = require('../_lib/shape');
const { toCents, genAccountId, genRecipientId } = require('../_lib/util');

function oid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

// Normalize saved Zelle recipients, keeping ids where present.
function normalizeRecipients(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((r) => ({
      id: String(r.id || genRecipientId()),
      name: String(r.name || '').trim().slice(0, 120),
      contact: String(r.contact || '').trim().slice(0, 120),
    }))
    .filter((r) => r.name && r.contact);
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

    // Zelle enrollment (contact + default account) — validate default account.
    if (body.zelle !== undefined && body.zelle) {
      const zelle = { ...(user.zelle || {}) };
      if (body.zelle.contact !== undefined) zelle.contact = String(body.zelle.contact).trim().slice(0, 120);
      if (body.zelle.defaultAccountId !== undefined) {
        const dId = String(body.zelle.defaultAccountId).trim();
        const accts = Array.isArray(body.accounts) ? body.accounts : (user.accounts || []);
        if (dId && !accts.some((a) => String(a.id || a.number) === dId)) {
          return json(res, 400, { error: 'Default Zelle account is not one of the user accounts' });
        }
        zelle.defaultAccountId = dId;
      }
      set.zelle = zelle;
    }

    // Saved Zelle recipients — full replace when provided.
    if (Array.isArray(body.zelleRecipients)) {
      set.zelleRecipients = normalizeRecipients(body.zelleRecipients);
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

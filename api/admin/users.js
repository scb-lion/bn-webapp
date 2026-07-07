// Admin users endpoint (admin only). Collection + single-item ops share one
// function (selected by ?id) to stay within the hosting plan's function limit.
//   GET    /api/admin/users        -> list all users
//   POST   /api/admin/users        -> create a user
//   GET    /api/admin/users?id=    -> one user + their transactions
//   PATCH  /api/admin/users?id=    -> update profile, email, role, active, password, accounts/balances
//   DELETE /api/admin/users?id=    -> delete a user and their transactions
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { publicUser, publicTxn } = require('../_lib/shape');
const { toCents, genAccountId, genRecipientId } = require('../_lib/util');
const { normalizeOverride } = require('../_lib/otp');

function oid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

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

function normalizeAccounts(input) {
  if (!Array.isArray(input)) return [];
  return input.map((a) => ({
    id: String(a.id || a.number || genAccountId()),
    type: String(a.type || 'Checking'),
    number: String(a.number || a.id || genAccountId()),
    name: String(a.name || a.type || 'Checking'),
    balance: toCents(a.balance),
  }));
}

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { users, transactions } = await collections();
  const idParam = (req.query || {}).id;

  // -------- single-user operations (?id=) --------
  if (idParam) {
    const _id = oid(idParam);
    if (!_id) return json(res, 400, { error: 'Bad or missing id' });

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

      // per-user OTP-login override ('default' | 'on' | 'off')
      if (body.security && body.security.otpLogin !== undefined) {
        const security = { ...(user.security || {}) };
        security.otpLogin = normalizeOverride(body.security.otpLogin);
        set.security = security;
      }

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
        set.accounts = normalizeAccounts(body.accounts);
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
  }

  // -------- collection operations --------
  if (req.method === 'GET') {
    const list = await users.find({}).sort({ createdAt: -1 }).toArray();
    return json(res, 200, { users: list.map(publicUser) });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!username || !password) {
      return json(res, 400, { error: 'username and password are required' });
    }
    if (password.length < 6) {
      return json(res, 400, { error: 'password must be at least 6 characters' });
    }
    const existing = await users.findOne({ username });
    if (existing) return json(res, 409, { error: 'username already taken' });

    const now = new Date();
    const accounts = normalizeAccounts(body.accounts);
    if (accounts.length === 0) {
      // Give every user one checking account by default.
      accounts.push({ id: genAccountId(), type: 'Checking', number: genAccountId(), name: 'Checking', balance: 0 });
    }
    const doc = {
      username,
      email: String(body.email || '').trim(),
      passwordHash: await bcrypt.hash(password, 10),
      role: body.role === 'admin' ? 'admin' : 'user',
      active: body.active !== false,
      profile: {
        firstName: String(body.firstName || '').trim(),
        displayName: String(body.displayName || body.firstName || '').trim(),
        photoUrl: String(body.photoUrl || '').trim(),
        phone: String(body.phone || '').trim(),
        address: String(body.address || '').trim(),
      },
      accounts,
      zelle: {
        contact: String((body.zelle && body.zelle.contact) || '').trim().slice(0, 120),
        defaultAccountId: String((body.zelle && body.zelle.defaultAccountId) || '').trim(),
      },
      zelleRecipients: normalizeRecipients(body.zelleRecipients),
      createdAt: now,
      updatedAt: now,
    };
    const result = await users.insertOne(doc);
    doc._id = result.insertedId;
    return json(res, 201, { user: publicUser(doc) });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

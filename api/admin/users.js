// GET  /api/admin/users  -> list all users (admin only)
// POST /api/admin/users  -> create a user (admin only)
const bcrypt = require('bcryptjs');
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { publicUser } = require('../_lib/shape');
const { toCents, genAccountId } = require('../_lib/util');

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

  const { users } = await collections();

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
      createdAt: now,
      updatedAt: now,
    };
    const result = await users.insertOne(doc);
    doc._id = result.insertedId;
    return json(res, 201, { user: publicUser(doc) });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

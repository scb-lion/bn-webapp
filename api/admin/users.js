// Admin users endpoint (admin only). Collection + single-item ops share one
// function (selected by ?id) to stay within the hosting plan's function limit.
//   GET    /api/admin/users        -> list all users
//   POST   /api/admin/users        -> create a user
//   GET    /api/admin/users?id=    -> one user + their transactions
//   PATCH  /api/admin/users?id=    -> update profile, email, role, active, password, accounts/balances
//   DELETE /api/admin/users?id=    -> delete a user and their transactions
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { publicUser, publicTxn } = require('../_lib/shape');
const { toCents, genAccountId, genRecipientId } = require('../_lib/util');
const { normalizeOverride } = require('../_lib/otp');
const { getEmailSettings, sendJointInvite, sendJointApproved, sendJointRejected } = require('../_lib/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function oid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

function primaryNameOf(primary) {
  return (primary && primary.profile && (primary.profile.displayName || primary.profile.firstName)) || (primary && primary.username) || '';
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

  const { users, transactions, invites } = await collections();

  // Joint-account invite management shares this function (?scope=invites) to
  // stay within the hosting plan's serverless-function limit — mirrors how
  // api/admin/email.js handles ?scope=auth.
  if (String((req.query || {}).scope || '') === 'invites') {
    return handleInvites(req, res, admin, users, invites);
  }

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

// ---- joint-account invites (?scope=invites) ----
//   POST /api/admin/users?scope=invites            { primaryUserId, spouseEmail } -> create + send
//   GET  /api/admin/users?scope=invites[&status=]  -> list (metadata only)
//   GET  /api/admin/users?scope=invites&id=        -> one invite, full detail (incl. docs)
//   POST /api/admin/users?scope=invites&id=        { action, reason } -> approve | reject
function inviteListItem(inv, primaryName) {
  return {
    id: String(inv._id),
    status: inv.status,
    spouseEmail: inv.spouseEmail,
    primaryName: primaryName || '',
    primaryUserId: String(inv.primaryUserId),
    applicantName: (inv.applicant && inv.applicant.fullName) || '',
    createdAt: inv.createdAt || null,
    submittedAt: inv.submittedAt || null,
    hasDocs: !!(inv.docs && inv.docs.idFront),
  };
}

function docSummary(doc) {
  return doc ? { data: doc.data, mime: doc.mime, name: doc.name } : null;
}

async function handleInvites(req, res, admin, users, invites) {
  const idParam = (req.query || {}).id;

  // Base URL for the shareable /join invite link, so an admin can copy it for any
  // invite (not just right after sending it).
  const settings = await getEmailSettings();
  const base = (settings.siteUrl || ('https://' + (req.headers.host || ''))).replace(/\/+$/, '');
  const linkFor = (inv) => base + '/join?token=' + inv.token;

  // -------- single-invite operations (?id=) --------
  if (idParam) {
    const _id = oid(idParam);
    if (!_id) return json(res, 400, { error: 'Bad or missing id' });
    const invite = await invites.findOne({ _id });
    if (!invite) return json(res, 404, { error: 'Not found' });

    if (req.method === 'GET') {
      const primary = await users.findOne({ _id: invite.primaryUserId });
      const accounts = ((primary && primary.accounts) || []).map((a) => ({
        name: a.name || a.type || 'Account',
        type: a.type || 'Checking',
        numberMasked: '••' + String(a.number || a.id || '').slice(-4),
        balance: Number.isFinite(a.balance) ? a.balance : 0,
      }));
      return json(res, 200, {
        invite: {
          id: String(invite._id),
          status: invite.status,
          spouseEmail: invite.spouseEmail,
          link: linkFor(invite),
          primaryName: primaryNameOf(primary),
          primaryUserId: String(invite.primaryUserId),
          applicant: invite.applicant || null,
          login: invite.login ? { username: invite.login.username, email: invite.login.email } : null,
          accounts,
          docs: {
            idFront: docSummary(invite.docs && invite.docs.idFront),
            idBack: docSummary(invite.docs && invite.docs.idBack),
            statement: docSummary(invite.docs && invite.docs.statement),
          },
          createdAt: invite.createdAt || null,
          submittedAt: invite.submittedAt || null,
          rejectReason: invite.rejectReason || '',
        },
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      if (action !== 'approve' && action !== 'reject') return json(res, 400, { error: 'action must be approve or reject' });
      if (!invite.spouseUserId) return json(res, 400, { error: 'This invite has not been submitted yet' });

      const spouse = await users.findOne({ _id: invite.spouseUserId });
      const now = new Date();

      if (action === 'approve') {
        if (spouse) await users.updateOne({ _id: spouse._id }, { $set: { jointStatus: 'approved', updatedAt: now } });
        await invites.updateOne({ _id }, { $set: { status: 'approved', reviewedAt: now, reviewedBy: admin._id } });
        if (spouse) await sendJointApproved(spouse); // best-effort
        return json(res, 200, { ok: true, status: 'approved' });
      }

      const reason = String(body.reason || '').trim().slice(0, 300);
      if (spouse) await users.updateOne({ _id: spouse._id }, { $set: { jointStatus: 'rejected', updatedAt: now } });
      await invites.updateOne({ _id }, { $set: { status: 'rejected', rejectReason: reason, reviewedAt: now, reviewedBy: admin._id } });
      if (spouse) await sendJointRejected(spouse, reason); // best-effort
      return json(res, 200, { ok: true, status: 'rejected' });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  // -------- collection: list / create --------
  if (req.method === 'GET') {
    const filter = {};
    const statusFilter = String((req.query || {}).status || '');
    if (statusFilter) filter.status = statusFilter;
    const list = await invites.find(filter).sort({ createdAt: -1 }).toArray();

    const primaryIds = Array.from(new Set(list.map((i) => String(i.primaryUserId))));
    const primaries = await users.find({ _id: { $in: primaryIds.map(oid).filter(Boolean) } }).toArray();
    const primaryMap = new Map(primaries.map((p) => [String(p._id), p]));

    const out = list.map((inv) => {
      const item = inviteListItem(inv, primaryNameOf(primaryMap.get(String(inv.primaryUserId))));
      item.link = linkFor(inv);
      return item;
    });
    return json(res, 200, { invites: out });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const primaryUserId = oid(body.primaryUserId);
    if (!primaryUserId) return json(res, 400, { error: 'Bad or missing primaryUserId' });
    const primary = await users.findOne({ _id: primaryUserId });
    if (!primary) return json(res, 404, { error: 'Primary user not found' });

    const spouseEmail = String(body.spouseEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(spouseEmail)) return json(res, 400, { error: 'Enter a valid email address' });

    const now = new Date();
    const token = crypto.randomBytes(20).toString('hex'); // 40 hex chars
    const doc = {
      token,
      primaryUserId,
      spouseEmail,
      status: 'sent',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      sentBy: admin._id,
    };
    const result = await invites.insertOne(doc);
    doc._id = result.insertedId;

    const link = linkFor(doc);

    let emailed = false, emailError = '';
    try {
      const r = await sendJointInvite(spouseEmail, link, primaryNameOf(primary));
      emailed = !!(r && r.live);
      if (!emailed) emailError = 'No live email sender is configured — the message was only previewed, not sent.';
    } catch (e) {
      // Surface the transport's reason (e.g. an SMTP bounce/rejection) to the
      // admin instead of swallowing it — the invite is still created either way.
      emailError = (e && e.message) || 'Send failed';
      console.error('[admin/invites] send failed (non-fatal):', emailError);
    }

    return json(res, 201, { ok: true, invite: inviteListItem(doc, primaryNameOf(primary)), emailed, emailError, link });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

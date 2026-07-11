// Zelle enrollment + saved recipients for the signed-in user.
//   GET    /api/zelle            -> { zelle, recipients }
//   POST   /api/zelle            -> add a recipient { name, contact }
//   DELETE /api/zelle?id=        -> remove a recipient
//   PATCH  /api/zelle            -> update preferences { contact, defaultAccountId }
const { collections } = require('./_lib/db');
const { requireAuth, resolveAccountOwner, json, readBody } = require('./_lib/auth');
const { publicRecipient } = require('./_lib/shape');
const { genRecipientId } = require('./_lib/util');

const s = (v) => String(v == null ? '' : v).trim().slice(0, 120);

function payload(user) {
  return {
    zelle: {
      contact: (user.zelle && user.zelle.contact) || '',
      defaultAccountId: (user.zelle && user.zelle.defaultAccountId) || '',
    },
    recipients: (user.zelleRecipients || []).map(publicRecipient),
  };
}

module.exports = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const owner = await resolveAccountOwner(user);
  const { users } = await collections();

  if (req.method === 'GET') {
    return json(res, 200, payload(owner));
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const name = s(body.name);
    const contact = s(body.contact);
    if (!name || !contact) return json(res, 400, { error: 'Name and email/phone are required' });
    const recipients = (owner.zelleRecipients || []).slice();
    if (recipients.some((r) => r.contact.toLowerCase() === contact.toLowerCase())) {
      return json(res, 409, { error: 'That recipient is already saved' });
    }
    recipients.push({ id: genRecipientId(), name, contact });
    await users.updateOne({ _id: owner._id }, { $set: { zelleRecipients: recipients, updatedAt: new Date() } });
    return json(res, 201, { recipients: recipients.map(publicRecipient) });
  }

  if (req.method === 'DELETE') {
    const id = s((req.query || {}).id);
    if (!id) return json(res, 400, { error: 'Missing recipient id' });
    const recipients = (owner.zelleRecipients || []).filter((r) => String(r.id) !== id);
    await users.updateOne({ _id: owner._id }, { $set: { zelleRecipients: recipients, updatedAt: new Date() } });
    return json(res, 200, { recipients: recipients.map(publicRecipient) });
  }

  if (req.method === 'PATCH') {
    const body = await readBody(req);
    const zelle = { ...(owner.zelle || {}) };
    if (body.contact !== undefined) zelle.contact = s(body.contact);
    if (body.defaultAccountId !== undefined) {
      const id = s(body.defaultAccountId);
      if (id && !(owner.accounts || []).some((a) => String(a.id) === id)) {
        return json(res, 400, { error: 'Default account is not one of your accounts' });
      }
      zelle.defaultAccountId = id;
    }
    await users.updateOne({ _id: owner._id }, { $set: { zelle: zelle, updatedAt: new Date() } });
    return json(res, 200, { zelle: { contact: zelle.contact || '', defaultAccountId: zelle.defaultAccountId || '' } });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

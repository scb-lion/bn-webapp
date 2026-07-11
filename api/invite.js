// Public, token-authenticated wizard for a spouse/partner joining an existing
// account as a joint holder. No session cookie — the invite `token` IS the
// auth. This is the ONE new serverless function this feature adds; everything
// else lives in existing files or shared api/_lib/* helpers.
//   GET  /api/invite?token=XXX                -> bootstrap the wizard
//   POST /api/invite  { token, action, ... }  -> register|summary|identity|upload|submit
const { collections } = require('./_lib/db');
const { json, readBody, signToken, setSessionCookie } = require('./_lib/auth');
const { sendCustomEmail, sendJointSubmitted } = require('./_lib/email');

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Show only the last 4 digits of an account number in the wizard summary.
function maskNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length > 4 ? '•••• ' + d.slice(-4) : (d || '••••');
}
// ID/DL front only — no password, no ID back, no statement: keeps the public
// (Safe-Browsing-scanned) page free of credential + financial-PII collection.
const DOC_TYPES = ['idFront'];
const MAX_DATA_LEN = 3500000; // ~2.6MB binary as base64

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

function primaryNameOf(primary) {
  return (primary && primary.profile && (primary.profile.displayName || primary.profile.firstName)) || (primary && primary.username) || '';
}

module.exports = async (req, res) => {
  const { invites, users } = await collections();

  const body = req.method === 'POST' ? await readBody(req) : {};
  const token = s(req.method === 'GET' ? (req.query || {}).token : body.token, 200);
  if (!token) return json(res, 400, { error: 'Missing token' });

  const invite = await invites.findOne({ token });
  if (!invite) return json(res, 404, { error: 'Invite not found' });

  const now = new Date();
  if ((invite.expiresAt && new Date(invite.expiresAt) < now) || invite.status === 'approved' || invite.status === 'rejected') {
    return json(res, 410, { error: 'This invite is no longer active' });
  }

  if (req.method === 'GET') return bootstrap(req, res, invite, users);
  if (req.method === 'POST') return dispatch(req, res, invite, invites, users, body);
  return json(res, 405, { error: 'Method not allowed' });
};

async function bootstrap(req, res, invite, users) {
  const primary = await users.findOne({ _id: invite.primaryUserId });
  return json(res, 200, {
    ok: true,
    invite: {
      status: invite.status,
      spouseEmail: invite.spouseEmail,
      primaryName: primaryNameOf(primary),
      hasLogin: !!(invite.login && invite.login.username),
      hasIdentity: !!(invite.applicant && invite.applicant.fullName),
      docs: {
        idFront: !!(invite.docs && invite.docs.idFront),
        idBack: !!(invite.docs && invite.docs.idBack),
        statement: !!(invite.docs && invite.docs.statement),
      },
    },
  });
}

async function dispatch(req, res, invite, invites, users, body) {
  body = body || {};
  const action = s(body.action, 40);

  if (action === 'register') return doRegister(res, invite, invites, users, body);
  if (action === 'summary') return doSummary(res, invite, users);
  if (action === 'identity') return doIdentity(res, invite, invites, body);
  if (action === 'upload') return doUpload(res, invite, invites, body);
  if (action === 'submit') return doSubmit(res, req, invite, invites, users, body);
  return json(res, 400, { error: 'Unknown action' });
}

async function doRegister(res, invite, invites, users, body) {
  const username = s(body.username, 30).toLowerCase();
  const email = s(body.email, 200).toLowerCase();

  if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'Username must be 3-30 characters: letters, numbers, dot, underscore, or dash' });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter a valid email address' });

  const takenUser = await users.findOne({ username });
  if (takenUser) return json(res, 409, { error: 'That username is already taken' });
  const takenInvite = await invites.findOne({ 'login.username': username, token: { $ne: invite.token } });
  if (takenInvite) return json(res, 409, { error: 'That username is already taken' });

  // No password — the account signs in with a one-time code sent to this email.
  await invites.updateOne(
    { _id: invite._id },
    { $set: { login: { username, email }, status: 'started', updatedAt: new Date() } }
  );
  return json(res, 200, { ok: true });
}

// Summary of the account the spouse is joining: whose it is, plus each account's
// name, masked number and balance (cents) and the combined total.
async function doSummary(res, invite, users) {
  if (!invite.login || !invite.login.username) return json(res, 400, { error: 'Set up your sign-in first' });
  const primary = await users.findOne({ _id: invite.primaryUserId });
  const accounts = ((primary && primary.accounts) || []).map((a) => ({
    name: a.name || a.type || 'Account',
    type: a.type || 'Checking',
    number: maskNumber(a.number),
    balance: Number.isFinite(a.balance) ? a.balance : 0, // cents
  }));
  const total = accounts.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);
  return json(res, 200, { ok: true, primaryName: primaryNameOf(primary), accounts, total });
}

async function doIdentity(res, invite, invites, body) {
  if (!invite.login || !invite.login.username) return json(res, 400, { error: 'Set up your sign-in first' });
  const fullName = s(body.fullName, 120);
  const dob = s(body.dob, 10);
  if (!fullName) return json(res, 400, { error: 'Full name is required' });
  if (!dob) return json(res, 400, { error: 'Date of birth is required' });

  await invites.updateOne(
    { _id: invite._id },
    { $set: { applicant: { fullName, dob }, updatedAt: new Date() } }
  );
  return json(res, 200, { ok: true });
}

async function doUpload(res, invite, invites, body) {
  if (!invite.login || !invite.login.username) return json(res, 400, { error: 'Create your login first' });
  const docType = s(body.docType, 20);
  if (DOC_TYPES.indexOf(docType) < 0) return json(res, 400, { error: 'Unknown document type' });

  const data = String(body.data || '');
  const mime = s(body.mime, 100);
  if (!data) return json(res, 400, { error: 'No file data received' });
  if (data.length > MAX_DATA_LEN) return json(res, 413, { error: 'File is too large — please choose a smaller file' });
  if (!/^image\//.test(mime) && mime !== 'application/pdf') return json(res, 400, { error: 'File must be an image or a PDF' });

  const docs = { ...(invite.docs || {}) };
  docs[docType] = {
    data,
    mime,
    name: s(body.name, 200),
    size: Number(body.size) || data.length,
    uploadedAt: new Date(),
  };
  await invites.updateOne({ _id: invite._id }, { $set: { docs, updatedAt: new Date() } });
  return json(res, 200, { ok: true });
}

async function doSubmit(res, req, invite, invites, users, body) {
  const missing = [];
  if (!invite.login || !invite.login.username) missing.push('login');
  if (!invite.applicant || !invite.applicant.fullName) missing.push('identity');
  if (!invite.docs || !invite.docs.idFront) missing.push('idFront');
  if (missing.length) return json(res, 400, { error: 'Missing required steps: ' + missing.join(', '), missing });

  const username = invite.login.username;
  const takenUser = await users.findOne({ username });
  if (takenUser) return json(res, 409, { error: 'That username is already taken — please go back and choose another' });

  const applicant = invite.applicant;
  const now = new Date();
  const spouseDoc = {
    username,
    // Passwordless: no passwordHash is stored. The account signs in only with a
    // one-time code emailed to `email` (login.js enforces email + OTP for these).
    passwordless: true,
    email: invite.login.email,
    role: 'user',
    active: true,
    jointOf: invite.primaryUserId,
    jointStatus: 'pending',
    inviteId: invite._id,
    profile: {
      firstName: (applicant.fullName || '').split(/\s+/)[0] || applicant.fullName,
      displayName: applicant.fullName,
      phone: '',
      address: '',
      photoUrl: '/assets/img/default-avatar.png',
    },
    security: { otpLogin: 'on' },
    accounts: [],
    createdAt: now,
    updatedAt: now,
  };
  const result = await users.insertOne(spouseDoc);
  spouseDoc._id = result.insertedId;

  await invites.updateOne(
    { _id: invite._id },
    { $set: { status: 'submitted', spouseUserId: spouseDoc._id, submittedAt: now, updatedAt: now } }
  );

  // Sign the new member in immediately (10-year session cookie) so they land on
  // their account signed in and can set a password from there. The account is
  // still `pending` until an admin approves, so the dashboard shows the review
  // notice — but they're authenticated and prompted to set a password.
  setSessionCookie(res, signToken(spouseDoc));

  // Neutral confirmation to the new member — no link, no financial terms.
  try { await sendJointSubmitted(spouseDoc); } catch (e) { /* non-fatal */ }

  // Best-effort: let the primary member know a request is waiting on their
  // review. Neutral wording, and never lets a notification failure block submit.
  try {
    const primary = await users.findOne({ _id: invite.primaryUserId });
    if (primary && primary.email) {
      await sendCustomEmail(
        primary,
        'A request is ready for your review',
        (applicant.fullName || 'Someone') + ' has completed a request to share access with you and it is now awaiting review.'
      );
    }
  } catch (e) {
    console.error('[invite] submit notification failed (non-fatal):', e && e.message);
  }

  return json(res, 200, { ok: true, redirect: '/user/dashboard' });
}

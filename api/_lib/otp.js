// One-time passcode (OTP) helpers for user login + password reset.
//
// Global settings live in the `settings` collection (singleton _id:'auth') and
// are editable by an admin. A per-user override on user.security.otpLogin can
// force OTP on/off for individual accounts. Admins never use OTP.
//
// A pending code is stored as a short-lived challenge in the `authChallenges`
// collection: the plaintext code is emailed to the user and only its bcrypt hash
// is stored, together with an expiry and an attempt cap. The random challenge id
// is handed to the client and used to redeem the code on the follow-up request.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { collections } = require('./db');

const DEFAULT_AUTH_SETTINGS = {
  otpLoginDefault: true, // global default: require OTP for user logins
  codeTtlMin: 10,        // how long an emailed code stays valid
  maxAttempts: 5,        // wrong tries before a challenge is burned
};

/* ---------- settings ---------- */
async function getAuthSettings() {
  try {
    const { settings } = await collections();
    const doc = await settings.findOne({ _id: 'auth' });
    if (!doc) return { ...DEFAULT_AUTH_SETTINGS };
    return {
      otpLoginDefault: doc.otpLoginDefault !== false,
      codeTtlMin: Number(doc.codeTtlMin) > 0 ? Number(doc.codeTtlMin) : DEFAULT_AUTH_SETTINGS.codeTtlMin,
      maxAttempts: Number(doc.maxAttempts) > 0 ? Number(doc.maxAttempts) : DEFAULT_AUTH_SETTINGS.maxAttempts,
    };
  } catch (e) {
    return { ...DEFAULT_AUTH_SETTINGS };
  }
}

async function saveAuthSettings(patch) {
  const { settings } = await collections();
  const current = await getAuthSettings();
  const next = {
    otpLoginDefault: patch.otpLoginDefault !== undefined ? !!patch.otpLoginDefault : current.otpLoginDefault,
    codeTtlMin: patch.codeTtlMin !== undefined && Number(patch.codeTtlMin) > 0 ? Number(patch.codeTtlMin) : current.codeTtlMin,
    maxAttempts: patch.maxAttempts !== undefined && Number(patch.maxAttempts) > 0 ? Number(patch.maxAttempts) : current.maxAttempts,
    updatedAt: new Date(),
  };
  await settings.updateOne({ _id: 'auth' }, { $set: next }, { upsert: true });
  return next;
}

// Normalize a per-user override value to one of 'default' | 'on' | 'off'.
function normalizeOverride(v) {
  const s = String(v || '').toLowerCase();
  return s === 'on' || s === 'off' ? s : 'default';
}

// Is an OTP login required for this user? Admins never are.
function otpRequiredFor(user, settings) {
  if (!user || user.role === 'admin') return false;
  const ov = normalizeOverride(user.security && user.security.otpLogin);
  if (ov === 'on') return true;
  if (ov === 'off') return false;
  return settings ? settings.otpLoginDefault !== false : true;
}

/* ---------- codes + challenges ---------- */
function generateCode() {
  // 6 digits, zero-padded, cryptographically random.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s;
  const local = s.slice(0, at);
  const domain = s.slice(at);
  const first = local[0];
  const last = local.length > 1 ? local[local.length - 1] : '';
  return first + '•••' + last + domain;
}

// Create a login/reset challenge, returning the id (for the client) and the
// plaintext code (to email). Any stale challenges for the user are cleared first.
async function createChallenge(user, purpose, settings) {
  const s = settings || (await getAuthSettings());
  const { authChallenges } = await collections();
  const userId = user._id;
  try { await authChallenges.deleteMany({ userId, purpose }); } catch (e) { /* best effort */ }
  const code = generateCode();
  const challengeId = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  await authChallenges.insertOne({
    _id: challengeId,
    purpose: purpose === 'reset' ? 'reset' : 'login',
    userId,
    username: user.username,
    codeHash: await bcrypt.hash(code, 10),
    attempts: 0,
    maxAttempts: s.maxAttempts,
    createdAt: now,
    expiresAt: new Date(now.getTime() + s.codeTtlMin * 60 * 1000),
  });
  return { challengeId, code, ttlMin: s.codeTtlMin };
}

// Verify a submitted code against a challenge. Returns { ok, userId } on success,
// or { ok:false, status, error } otherwise. Consumes the challenge on success.
async function verifyChallenge(challengeId, code, purpose) {
  const { authChallenges } = await collections();
  const id = String(challengeId || '');
  const ch = id ? await authChallenges.findOne({ _id: id }) : null;
  if (!ch || ch.purpose !== (purpose === 'reset' ? 'reset' : 'login')) {
    return { ok: false, status: 400, error: 'This code request is invalid. Please start again.' };
  }
  if (new Date(ch.expiresAt).getTime() < Date.now()) {
    await authChallenges.deleteOne({ _id: id });
    return { ok: false, status: 400, error: 'This code has expired. Please request a new one.' };
  }
  if ((ch.attempts || 0) >= (ch.maxAttempts || DEFAULT_AUTH_SETTINGS.maxAttempts)) {
    await authChallenges.deleteOne({ _id: id });
    return { ok: false, status: 429, error: 'Too many attempts. Please request a new code.' };
  }
  const match = await bcrypt.compare(String(code || ''), ch.codeHash || '');
  if (!match) {
    await authChallenges.updateOne({ _id: id }, { $inc: { attempts: 1 } });
    const left = (ch.maxAttempts || DEFAULT_AUTH_SETTINGS.maxAttempts) - (ch.attempts || 0) - 1;
    return { ok: false, status: 400, error: left > 0 ? 'Incorrect code. ' + left + ' attempt' + (left === 1 ? '' : 's') + ' left.' : 'Incorrect code. Please request a new one.' };
  }
  await authChallenges.deleteOne({ _id: id });
  return { ok: true, userId: ch.userId };
}

module.exports = {
  DEFAULT_AUTH_SETTINGS,
  getAuthSettings,
  saveAuthSettings,
  normalizeOverride,
  otpRequiredFor,
  maskEmail,
  createChallenge,
  verifyChallenge,
};

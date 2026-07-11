const bcrypt = require('bcryptjs');
const { collections } = require('../_lib/db');
const { signToken, setSessionCookie, json, readBody } = require('../_lib/auth');
const { sendEventEmail, sendCode } = require('../_lib/email');
const { getAuthSettings, otpRequiredFor, createChallenge, maskEmail } = require('../_lib/otp');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = await readBody(req);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username) {
    return json(res, 400, { error: 'Username is required' });
  }

  const { users } = await collections();
  const user = await users.findOne({ username });

  // Passwordless accounts (joint-invite members) carry no passwordHash — the
  // emailed one-time code is their only factor, so we skip the password check
  // for them. Everyone else must present a matching password.
  const passwordless = !!user && user.active !== false && (user.passwordless === true || !user.passwordHash);
  if (!passwordless) {
    if (!password) return json(res, 400, { error: 'Username and password are required' });
    // Constant-ish response regardless of which check fails, to avoid user enumeration.
    const ok = user && user.active !== false && (await bcrypt.compare(password, user.passwordHash || ''));
    if (!ok) return json(res, 401, { error: 'Invalid username or password' });
  }

  // Passwordless accounts MUST verify a code and MUST have an email — fail closed
  // so an account can never sign in with no factor at all.
  if (passwordless && !user.email) {
    return json(res, 403, { error: 'This account cannot sign in yet. Please contact support.' });
  }

  // Step-up: if this account must verify a one-time code (and has an email to
  // receive it), don't create a session yet — email a code and ask for it.
  const authSettings = await getAuthSettings();
  if ((passwordless || otpRequiredFor(user, authSettings)) && user.email) {
    const { challengeId, code, ttlMin } = await createChallenge(user, 'login', authSettings);
    await sendCode(user, 'login', code, ttlMin); // non-fatal
    return json(res, 200, {
      otpRequired: true,
      challengeId: challengeId,
      maskedEmail: maskEmail(user.email),
      ttlMin: ttlMin,
    });
  }

  // No OTP required (or no email on file) — sign in directly.
  setSessionCookie(res, signToken(user));

  // Best-effort sign-in alert (skipped automatically for accounts without an email).
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  await sendEventEmail(user, 'login', { when: new Date(), ip: ip, device: String(req.headers['user-agent'] || '') });

  return json(res, 200, { ok: true, role: user.role, redirect: user.role === 'admin' ? '/admin' : '/user/dashboard' });
};

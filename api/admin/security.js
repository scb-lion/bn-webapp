// Admin login-security settings (admin only).
//   GET    /api/admin/security   -> current OTP settings
//   PATCH  /api/admin/security   -> update the global OTP-login toggle / code TTL
const { json, readBody, requireAdmin } = require('../_lib/auth');
const { getAuthSettings, saveAuthSettings } = require('../_lib/otp');

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    return json(res, 200, { settings: await getAuthSettings() });
  }

  if (req.method === 'PATCH') {
    const body = await readBody(req);
    const patch = {};
    if (body.otpLoginDefault !== undefined) patch.otpLoginDefault = !!body.otpLoginDefault;
    if (body.codeTtlMin !== undefined) patch.codeTtlMin = body.codeTtlMin;
    if (body.maxAttempts !== undefined) patch.maxAttempts = body.maxAttempts;
    return json(res, 200, { settings: await saveAuthSettings(patch) });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

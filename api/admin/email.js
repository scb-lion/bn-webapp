// Admin email settings + manual sending (admin only).
//   GET    /api/admin/email                         -> current settings (password masked)
//   PATCH  /api/admin/email                         -> update SMTP settings / toggles
//   POST   /api/admin/email  { action:'test', to }  -> send a test email
//   POST   /api/admin/email  { action:'send', userId, subject, message } -> custom email to a user
const { ObjectId } = require('mongodb');
const { collections } = require('../_lib/db');
const { requireAdmin, json, readBody } = require('../_lib/auth');
const { getEmailSettings, saveEmailSettings, isConfigured, sendTestEmail, sendCustomEmail } = require('../_lib/email');

// Never expose the stored SMTP password; report only whether one is set.
function publicSettings(s) {
  return {
    enabled: s.enabled !== false,
    smtp: { host: s.smtp.host, port: s.smtp.port, secure: !!s.smtp.secure, user: s.smtp.user, hasPassword: !!s.smtp.pass },
    from: { name: s.from.name, email: s.from.email },
    events: s.events,
    configured: isConfigured(s),
  };
}

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    return json(res, 200, { settings: publicSettings(await getEmailSettings()) });
  }

  if (req.method === 'PATCH') {
    const body = await readBody(req);
    const patch = {};
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.smtp) {
      patch.smtp = {};
      ['host', 'port', 'secure', 'user', 'pass'].forEach((k) => { if (body.smtp[k] !== undefined) patch.smtp[k] = body.smtp[k]; });
    }
    if (body.from) {
      patch.from = {};
      ['name', 'email'].forEach((k) => { if (body.from[k] !== undefined) patch.from[k] = body.from[k]; });
    }
    if (body.events && typeof body.events === 'object') {
      patch.events = {};
      Object.keys(body.events).forEach((k) => { patch.events[k] = !!body.events[k]; });
    }
    const saved = await saveEmailSettings(patch);
    return json(res, 200, { settings: publicSettings(saved) });
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    const action = String(body.action || '');

    if (action === 'test') {
      const settings = await getEmailSettings();
      const to = String(body.to || settings.from.email || settings.smtp.user || admin.email || '').trim();
      if (!to) return json(res, 400, { error: 'No recipient — set a From email or SMTP user first' });
      try {
        const r = await sendTestEmail(to);
        return json(res, 200, { ok: true, to, live: r.live, note: r.live ? 'Test email sent.' : 'SMTP not configured — previewed only (nothing sent). Add host, user and app password to send for real.' });
      } catch (e) {
        return json(res, 502, { error: 'Send failed: ' + (e && e.message || 'unknown error') });
      }
    }

    if (action === 'send') {
      const subject = String(body.subject || '').trim();
      const message = String(body.message || '').trim();
      if (!subject || !message) return json(res, 400, { error: 'Subject and message are required' });
      let _id;
      try { _id = new ObjectId(String(body.userId)); } catch { return json(res, 400, { error: 'Bad user id' }); }
      const { users } = await collections();
      const user = await users.findOne({ _id });
      if (!user) return json(res, 404, { error: 'User not found' });
      if (!user.email) return json(res, 400, { error: 'That user has no email address on file' });
      try {
        const r = await sendCustomEmail(user, subject, message);
        return json(res, 200, { ok: true, to: user.email, live: r.live, note: r.live ? 'Email sent to ' + user.email : 'SMTP not configured — previewed only (nothing sent).' });
      } catch (e) {
        return json(res, 502, { error: 'Send failed: ' + (e && e.message || 'unknown error') });
      }
    }

    return json(res, 400, { error: 'Unknown action' });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

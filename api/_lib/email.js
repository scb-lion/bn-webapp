// Branded transactional email for Alliance Federal Credit Union.
//
// SMTP settings live in the `settings` collection (singleton _id:'email') and are
// editable by an admin (Gmail defaults prefilled). When SMTP isn't fully
// configured we fall back to nodemailer's jsonTransport, which renders + logs the
// message but sends nothing — so events never break and nothing goes out by
// accident. Every send path is non-fatal: email failures never break the banking
// action that triggered them.
const nodemailer = require('nodemailer');
const { collections } = require('./db');
const logo = require('./logo');

const BRAND = {
  name: 'Alliance Federal Credit Union',
  green: '#0f6b3b',
  greenDark: '#0b4f2c',
  accent: '#007a3a',
  ink: '#13120f',
  muted: '#6b7280',
  line: '#e6e9e7',
  bg: '#f1f4f2',
};

const DEFAULT_SETTINGS = {
  enabled: true,
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: '', pass: '' },
  from: { name: BRAND.name, email: '' },
  events: { transferSubmitted: true, transferApproved: true, transferRejected: true, login: true },
};

/* ---------- settings ---------- */
async function getEmailSettings() {
  try {
    const { settings } = await collections();
    const doc = await settings.findOne({ _id: 'email' });
    if (!doc) return { ...DEFAULT_SETTINGS };
    return {
      enabled: doc.enabled !== false,
      smtp: { ...DEFAULT_SETTINGS.smtp, ...(doc.smtp || {}) },
      from: { ...DEFAULT_SETTINGS.from, ...(doc.from || {}) },
      events: { ...DEFAULT_SETTINGS.events, ...(doc.events || {}) },
    };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveEmailSettings(patch) {
  const { settings } = await collections();
  const current = await getEmailSettings();
  const next = {
    enabled: patch.enabled !== undefined ? !!patch.enabled : current.enabled,
    smtp: {
      host: String((patch.smtp && patch.smtp.host) ?? current.smtp.host).trim(),
      port: Number((patch.smtp && patch.smtp.port) ?? current.smtp.port) || 465,
      secure: (patch.smtp && patch.smtp.secure !== undefined) ? !!patch.smtp.secure : current.smtp.secure,
      user: String((patch.smtp && patch.smtp.user) ?? current.smtp.user).trim(),
      // keep existing password when the field comes through empty (masked in the UI)
      pass: (patch.smtp && patch.smtp.pass) ? String(patch.smtp.pass) : current.smtp.pass,
    },
    from: {
      name: String((patch.from && patch.from.name) ?? current.from.name).trim() || BRAND.name,
      email: String((patch.from && patch.from.email) ?? current.from.email).trim(),
    },
    events: { ...current.events, ...(patch.events || {}) },
    updatedAt: new Date(),
  };
  await settings.updateOne({ _id: 'email' }, { $set: next }, { upsert: true });
  return next;
}

function isConfigured(s) {
  return !!(s && s.smtp && s.smtp.host && s.smtp.user && s.smtp.pass);
}

function getTransporter(s) {
  if (!isConfigured(s)) return { tx: nodemailer.createTransport({ jsonTransport: true }), live: false };
  return {
    tx: nodemailer.createTransport({
      host: s.smtp.host,
      port: Number(s.smtp.port) || 465,
      secure: !!s.smtp.secure,
      auth: { user: s.smtp.user, pass: s.smtp.pass },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    }),
    live: true,
  };
}

/* ---------- helpers ---------- */
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function money(cents) {
  return '$' + ((Number(cents) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fromHeader(s) {
  const email = (s.from && s.from.email) || (s.smtp && s.smtp.user) || '';
  const name = (s.from && s.from.name) || BRAND.name;
  return email ? '"' + name.replace(/"/g, '') + '" <' + email + '>' : name;
}
function kindLabel(kind, meta) {
  const labels = { internal: 'Internal Transfer', domestic: 'Domestic Transfer', wire: 'Wire / ACH Transfer', zelle: 'Zelle®', deposit: 'Mobile Check Deposit' };
  let base = labels[kind] || 'Transfer';
  if (kind === 'zelle') base += ((meta && meta.mode) === 'request' ? ' Request' : ' Payment');
  return base;
}

/* ---------- branded base template ----------
   content = { preheader, heading, intro, rows:[{label,value}], highlight:{amount,label,color},
               statusBadge:{label,bg,fg}, cta:{label,url}, footerNote } */
function renderEmail(content) {
  const c = content || {};
  const rowsHtml = (c.rows || []).map(function (r) {
    return '<tr>' +
      '<td style="padding:9px 0;border-bottom:1px solid ' + BRAND.line + ';color:' + BRAND.muted + ';font-size:13px;">' + esc(r.label) + '</td>' +
      '<td style="padding:9px 0;border-bottom:1px solid ' + BRAND.line + ';color:' + BRAND.ink + ';font-size:13px;font-weight:600;text-align:right;">' + esc(r.value) + '</td>' +
    '</tr>';
  }).join('');

  const badge = c.statusBadge
    ? '<span style="display:inline-block;margin-top:10px;padding:4px 14px;border-radius:12px;font-size:12px;font-weight:700;background:' + c.statusBadge.bg + ';color:' + c.statusBadge.fg + ';">' + esc(c.statusBadge.label) + '</span>'
    : '';

  const highlight = c.highlight
    ? '<div style="text-align:center;padding:6px 0 2px;">' +
        '<div style="font-size:34px;font-weight:800;color:' + (c.highlight.color || BRAND.ink) + ';letter-spacing:-.5px;">' + esc(c.highlight.amount) + '</div>' +
        (c.highlight.label ? '<div style="font-size:12px;color:' + BRAND.muted + ';margin-top:2px;">' + esc(c.highlight.label) + '</div>' : '') +
        badge +
      '</div>'
    : '';

  const cta = c.cta
    ? '<div style="text-align:center;margin:22px 0 6px;"><a href="' + esc(c.cta.url) + '" style="background:' + BRAND.accent + ';color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 26px;border-radius:10px;display:inline-block;">' + esc(c.cta.label) + '</a></div>'
    : '';

  const table = rowsHtml
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;border-collapse:collapse;">' + rowsHtml + '</table>'
    : '';

  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(c.preheader || c.heading || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.bg + ';padding:24px 12px;">' +
    '<tr><td align="center">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,.08);">' +
        // brand header
        '<tr><td style="background:' + BRAND.green + ';padding:22px 28px;" align="left">' +
          '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
            '<td style="padding-right:12px;"><img src="cid:brandlogo" width="40" height="40" alt="" style="display:block;border-radius:8px;background:#fff;padding:4px;"></td>' +
            '<td style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;line-height:1.2;">' + esc(BRAND.name) + '</td>' +
          '</tr></table>' +
        '</td></tr>' +
        // body
        '<tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif;color:' + BRAND.ink + ';">' +
          (c.heading ? '<h1 style="margin:0 0 6px;font-size:20px;font-weight:800;color:' + BRAND.ink + ';">' + esc(c.heading) + '</h1>' : '') +
          (c.intro ? '<p style="margin:0 0 4px;font-size:14px;line-height:21px;color:#374151;">' + c.intro + '</p>' : '') +
          highlight + table + cta +
          (c.footerNote ? '<p style="margin:16px 0 0;font-size:12px;line-height:18px;color:' + BRAND.muted + ';">' + c.footerNote + '</p>' : '') +
        '</td></tr>' +
        // footer
        '<tr><td style="padding:18px 28px 24px;background:#fafbfa;border-top:1px solid ' + BRAND.line + ';font-family:Arial,Helvetica,sans-serif;">' +
          '<p style="margin:0 0 4px;font-size:12px;color:' + BRAND.muted + ';">' + esc(BRAND.name) + '</p>' +
          '<p style="margin:0;font-size:11px;line-height:16px;color:#9aa0a6;">This is an automated message about your account activity. This is a fictional demo institution — please do not reply to this email.</p>' +
        '</td></tr>' +
      '</table>' +
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9aa0a6;margin-top:14px;">&copy; ' + new Date().getFullYear() + ' ' + esc(BRAND.name) + '</div>' +
    '</td></tr></table></body></html>';
}

function greeting(user) {
  const name = (user && user.profile && (user.profile.firstName || user.profile.displayName)) || (user && user.username) || 'there';
  return 'Hi ' + esc(name) + ',';
}

/* ---------- per-event content ---------- */
function directionLabel(kind, meta, direction) {
  if (direction === 'in') return 'Incoming';
  if (kind === 'deposit') return 'Incoming';
  return 'Outgoing';
}

function buildTransferSubmitted(user, d) {
  const label = kindLabel(d.kind, d.meta);
  const rows = [
    { label: 'Type', value: label },
    { label: 'Amount', value: money(d.amountCents) },
    { label: 'Status', value: 'Pending review' },
  ];
  if (d.counterparty) rows.splice(2, 0, { label: d.direction === 'in' ? 'From' : 'To', value: d.counterparty });
  if (d.transferId) rows.push({ label: 'Reference', value: d.transferId });
  return {
    subject: label + ' submitted — pending review',
    content: {
      preheader: 'We received your ' + label + ' request for ' + money(d.amountCents) + '.',
      heading: 'Transfer submitted',
      intro: greeting(user) + '<br>We’ve received your <b>' + esc(label) + '</b> request. It’s <b>pending review</b> and will be processed once approved. You’ll get another email when its status changes.',
      highlight: { amount: money(d.amountCents), label: directionLabel(d.kind, d.meta, d.direction) + ' · ' + label, color: BRAND.ink },
      statusBadge: { label: 'Pending', bg: '#fff2d6', fg: '#a06b00' },
      rows: rows,
      footerNote: 'If you didn’t make this request, contact support right away.',
    },
  };
}

function buildTransferApproved(user, d) {
  const label = kindLabel(d.kind, d.meta);
  const incoming = d.direction === 'in' || d.kind === 'deposit';
  const rows = [
    { label: 'Type', value: label },
    { label: 'Amount', value: money(d.amountCents) },
    { label: 'Status', value: 'Completed' },
  ];
  if (d.transferId) rows.push({ label: 'Reference', value: d.transferId });
  return {
    subject: label + ' completed',
    content: {
      preheader: 'Your ' + label + ' of ' + money(d.amountCents) + ' is complete.',
      heading: 'Transfer completed',
      intro: greeting(user) + '<br>Good news — your <b>' + esc(label) + '</b> has been <b>approved and processed</b>. The amount has ' + (incoming ? 'been credited to' : 'posted from') + ' your account.',
      highlight: { amount: (incoming ? '+' : '−') + money(d.amountCents), label: label, color: incoming ? '#1a7f37' : BRAND.ink },
      statusBadge: { label: 'Completed', bg: '#e6f4ea', fg: '#1a7f37' },
      rows: rows,
    },
  };
}

function buildTransferRejected(user, d) {
  const label = kindLabel(d.kind, d.meta);
  const rows = [
    { label: 'Type', value: label },
    { label: 'Amount', value: money(d.amountCents) },
    { label: 'Status', value: 'Declined' },
  ];
  if (d.transferId) rows.push({ label: 'Reference', value: d.transferId });
  return {
    subject: label + ' declined',
    content: {
      preheader: 'Your ' + label + ' of ' + money(d.amountCents) + ' was declined.',
      heading: 'Transfer declined',
      intro: greeting(user) + '<br>Your <b>' + esc(label) + '</b> request was <b>declined</b> and <b>no money was moved</b>. If you have questions, please contact support.',
      highlight: { amount: money(d.amountCents), label: label, color: BRAND.muted },
      statusBadge: { label: 'Declined', bg: '#eef1f0', fg: '#7a857f' },
      rows: rows,
    },
  };
}

function buildLogin(user, d) {
  const when = d && d.when ? new Date(d.when) : new Date();
  const rows = [{ label: 'When', value: when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) }];
  if (d && d.ip) rows.push({ label: 'IP address', value: d.ip });
  if (d && d.device) rows.push({ label: 'Device', value: d.device });
  return {
    subject: 'New sign-in to your account',
    content: {
      preheader: 'A new sign-in to your Alliance account was detected.',
      heading: 'New sign-in detected',
      intro: greeting(user) + '<br>We noticed a sign-in to your <b>' + esc(BRAND.name) + '</b> account. If this was you, no action is needed.',
      rows: rows,
      footerNote: 'If this wasn’t you, change your password and contact support immediately.',
    },
  };
}

const BUILDERS = {
  transferSubmitted: buildTransferSubmitted,
  transferApproved: buildTransferApproved,
  transferRejected: buildTransferRejected,
  login: buildLogin,
};

/* ---------- send ---------- */
async function sendRaw(settings, msg) {
  const { tx, live } = getTransporter(settings);
  const mail = {
    from: fromHeader(settings),
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text || undefined,
    attachments: [{ filename: logo.filename, content: logo.buffer(), contentType: logo.contentType, cid: 'brandlogo' }],
  };
  const info = await tx.sendMail(mail);
  if (!live) console.log('[email] (preview — SMTP not configured) to=%s subject=%s', msg.to, msg.subject);
  else console.log('[email] sent to=%s subject=%s id=%s', msg.to, msg.subject, info.messageId);
  return { ok: true, live: live, info: info };
}

// Fire an automated event email to a user. Never throws.
async function sendEventEmail(user, eventType, data) {
  try {
    if (!user || !user.email) return { ok: false, skipped: 'no-email' };
    const settings = await getEmailSettings();
    if (!settings.enabled) return { ok: false, skipped: 'disabled' };
    if (settings.events && settings.events[eventType] === false) return { ok: false, skipped: 'event-off' };
    const builder = BUILDERS[eventType];
    if (!builder) return { ok: false, skipped: 'unknown-event' };
    const built = builder(user, data || {});
    return await sendRaw(settings, { to: user.email, subject: built.subject, html: renderEmail(built.content), text: built.content.preheader });
  } catch (e) {
    console.error('[email] sendEventEmail failed (non-fatal):', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

// Admin: send a custom message to a user, wrapped in the brand template.
async function sendCustomEmail(user, subject, message) {
  const settings = await getEmailSettings();
  const paras = String(message || '').split(/\n{2,}/).map(function (p) {
    return '<p style="margin:0 0 12px;font-size:14px;line-height:21px;color:#374151;">' + esc(p).replace(/\n/g, '<br>') + '</p>';
  }).join('');
  const content = {
    preheader: subject,
    heading: subject,
    intro: greeting(user),
    footerNote: '',
  };
  // Put the message body between intro and footer via a custom render.
  const html = renderEmail({ preheader: subject, heading: subject, intro: greeting(user) + '<br>' + '<span></span>' })
    .replace('<span></span>', paras);
  return await sendRaw(settings, { to: user.email, subject: subject, html: html, text: message });
}

// Admin: verify the SMTP config with a self-addressed test email.
async function sendTestEmail(to) {
  const settings = await getEmailSettings();
  const content = {
    preheader: 'Your Alliance email settings are working.',
    heading: 'SMTP test successful',
    intro: 'This is a test email from your ' + esc(BRAND.name) + ' admin panel. If you can read this, your SMTP settings are working. ✅',
    rows: [
      { label: 'Host', value: settings.smtp.host + ':' + settings.smtp.port },
      { label: 'From', value: fromHeader(settings) },
      { label: 'Sent', value: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) },
    ],
  };
  return await sendRaw(settings, { to: to, subject: 'Test email — Alliance email settings', html: renderEmail(content), text: 'SMTP test successful.' });
}

module.exports = {
  DEFAULT_SETTINGS,
  getEmailSettings,
  saveEmailSettings,
  isConfigured,
  sendEventEmail,
  sendCustomEmail,
  sendTestEmail,
  renderEmail, // exported for local preview/testing
  builders: BUILDERS, // exported for local preview/testing
};

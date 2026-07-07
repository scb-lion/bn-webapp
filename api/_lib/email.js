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
  siteUrl: '', // e.g. https://your-site.vercel.app — used for hosted logo + button links
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: '', pass: '' },
  from: { name: BRAND.name, email: '' },
  events: { transferSubmitted: true, transferApproved: true, transferRejected: true, transactionPosted: true, login: true },
};

function cleanUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

/* ---------- settings ---------- */
async function getEmailSettings() {
  try {
    const { settings } = await collections();
    const doc = await settings.findOne({ _id: 'email' });
    if (!doc) return { ...DEFAULT_SETTINGS };
    return {
      enabled: doc.enabled !== false,
      siteUrl: cleanUrl(doc.siteUrl || ''),
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
    siteUrl: patch.siteUrl !== undefined ? cleanUrl(patch.siteUrl) : current.siteUrl,
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
               code, codeLabel, statusBadge:{label,bg,fg}, cta:{label,path}, footerNote }
   opts    = { logoSrc, siteUrl } */
const FONT = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;';
function resolveUrl(pathOrUrl, siteUrl) {
  if (!pathOrUrl) return '';
  if (/^https?:/i.test(pathOrUrl)) return pathOrUrl;
  return siteUrl ? siteUrl + pathOrUrl : '';
}
function renderEmail(content, opts) {
  const c = content || {};
  const o = opts || {};
  const logoSrc = o.logoSrc || 'cid:brandlogo';
  const ctaUrl = c.cta ? resolveUrl(c.cta.path || c.cta.url, o.siteUrl) : '';

  const rowsHtml = (c.rows || []).map(function (r, i) {
    var last = i === c.rows.length - 1;
    return '<tr>' +
      '<td style="padding:11px 0;' + (last ? '' : 'border-bottom:1px solid ' + BRAND.line + ';') + 'color:' + BRAND.muted + ';font-size:13px;">' + esc(r.label) + '</td>' +
      '<td style="padding:11px 0;' + (last ? '' : 'border-bottom:1px solid ' + BRAND.line + ';') + 'color:' + BRAND.ink + ';font-size:13px;font-weight:700;text-align:right;">' + esc(r.value) + '</td>' +
    '</tr>';
  }).join('');

  const badge = c.statusBadge
    ? '<div style="margin-top:12px;"><span style="display:inline-block;padding:5px 16px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:.02em;background:' + c.statusBadge.bg + ';color:' + c.statusBadge.fg + ';">' + esc(c.statusBadge.label) + '</span></div>'
    : '';

  // Amount highlight sits inside a soft rounded panel so it stands out.
  const highlight = c.highlight
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;"><tr><td style="background:#f2f8f4;border:1px solid #e2efe8;border-radius:14px;padding:22px 16px;text-align:center;">' +
        '<div style="font-size:36px;font-weight:800;color:' + (c.highlight.color || BRAND.ink) + ';letter-spacing:-.6px;line-height:1.05;">' + esc(c.highlight.amount) + '</div>' +
        (c.highlight.label ? '<div style="font-size:12px;color:' + BRAND.muted + ';margin-top:5px;letter-spacing:.02em;">' + esc(c.highlight.label) + '</div>' : '') +
        badge +
      '</td></tr></table>'
    : '';

  // One-time passcode panel — large, letter-spaced, easy to read/copy.
  const codeBlock = c.code
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;"><tr><td style="background:#f2f8f4;border:1px solid #e2efe8;border-radius:14px;padding:22px 16px;text-align:center;">' +
        '<div style="font-family:Consolas,Menlo,Monaco,monospace;font-size:34px;font-weight:800;letter-spacing:9px;color:' + BRAND.green + ';line-height:1.1;">' + esc(c.code) + '</div>' +
        (c.codeLabel ? '<div style="font-size:12px;color:' + BRAND.muted + ';margin-top:8px;letter-spacing:.02em;">' + esc(c.codeLabel) + '</div>' : '') +
      '</td></tr></table>'
    : '';

  const cta = ctaUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 4px;"><tr><td style="border-radius:10px;background:' + BRAND.accent + ';">' +
        '<a href="' + esc(ctaUrl) + '" style="' + FONT + 'color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 30px;border-radius:10px;display:inline-block;">' + esc(c.cta.label) + '</a>' +
      '</td></tr></table>'
    : '';

  const table = rowsHtml
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;border-collapse:collapse;">' + rowsHtml + '</table>'
    : '';

  const homeLink = o.siteUrl ? '<a href="' + esc(o.siteUrl) + '" style="color:' + BRAND.accent + ';text-decoration:none;">' + esc(o.siteUrl.replace(/^https?:\/\//, '')) + '</a>' : esc(BRAND.name);

  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';-webkit-font-smoothing:antialiased;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">' + esc(c.preheader || c.heading || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.bg + ';padding:28px 12px;">' +
    '<tr><td align="center">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(16,60,40,.10);">' +
        // brand header — centered landscape logo on the green bar
        '<tr><td align="center" style="background:' + BRAND.green + ';padding:26px 28px;">' +
          '<img src="' + esc(logoSrc) + '" width="196" alt="' + esc(BRAND.name) + '" style="display:block;width:196px;max-width:70%;height:auto;border:0;">' +
        '</td></tr>' +
        // accent divider
        '<tr><td style="height:4px;line-height:4px;font-size:0;background:' + BRAND.accent + ';">&nbsp;</td></tr>' +
        // body
        '<tr><td style="padding:32px 32px 28px;' + FONT + 'color:' + BRAND.ink + ';">' +
          (c.heading ? '<h1 style="margin:0 0 8px;font-size:21px;font-weight:800;color:' + BRAND.ink + ';letter-spacing:-.3px;">' + esc(c.heading) + '</h1>' : '') +
          (c.intro ? '<p style="margin:0;font-size:14px;line-height:22px;color:#3f4a45;">' + c.intro + '</p>' : '') +
          (c.bodyHtml || '') +
          codeBlock + highlight + table + cta +
          (c.footerNote ? '<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:' + BRAND.muted + ';">' + c.footerNote + '</p>' : '') +
        '</td></tr>' +
        // footer
        '<tr><td style="padding:20px 32px 26px;background:#f7faf8;border-top:1px solid ' + BRAND.line + ';' + FONT + '">' +
          '<p style="margin:0 0 5px;font-size:12px;font-weight:700;color:' + BRAND.ink + ';">' + esc(BRAND.name) + '</p>' +
          '<p style="margin:0 0 8px;font-size:11px;line-height:16px;color:#9aa0a6;">This is an automated message about your account activity — please do not reply to this email.</p>' +
          '<p style="margin:0;font-size:11px;color:#9aa0a6;">' + homeLink + ' &nbsp;·&nbsp; &copy; ' + new Date().getFullYear() + '</p>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table></body></html>';
}

// Plain-text alternative (improves deliverability + accessibility).
function toText(content, siteUrl) {
  const c = content || {};
  const strip = function (s) { return String(s || '').replace(/<br\s*\/?>(?=)/gi, '\n').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim(); };
  const lines = [];
  if (c.heading) lines.push(c.heading, '');
  if (c.intro) lines.push(strip(c.intro), '');
  if (c.bodyHtml) lines.push(strip(c.bodyHtml), '');
  if (c.code) lines.push(c.code + (c.codeLabel ? '  (' + c.codeLabel + ')' : ''), '');
  if (c.highlight) lines.push(c.highlight.amount + (c.highlight.label ? '  (' + c.highlight.label + ')' : ''), '');
  (c.rows || []).forEach(function (r) { lines.push(r.label + ': ' + r.value); });
  if (c.cta) { const u = resolveUrl(c.cta.path || c.cta.url, siteUrl); if (u) lines.push('', c.cta.label + ': ' + u); }
  if (c.footerNote) lines.push('', strip(c.footerNote));
  lines.push('', '— ' + BRAND.name + '. Please do not reply.');
  return lines.join('\n');
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
      cta: { label: 'View in your account', path: '/user/dashboard' },
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
      cta: { label: 'View in your account', path: '/user/dashboard' },
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
      cta: { label: 'View in your account', path: '/user/dashboard' },
    },
  };
}

// A transaction the admin posted directly to the account (credit or debit).
function buildTransactionPosted(user, d) {
  const incoming = (Number(d.amountCents) || 0) >= 0;
  const mag = Math.abs(Number(d.amountCents) || 0);
  const rows = [
    { label: 'Type', value: incoming ? 'Credit' : 'Debit' },
    { label: 'Amount', value: money(mag) },
  ];
  if (d.description) rows.push({ label: 'Description', value: d.description });
  if (d.counterparty) rows.push({ label: incoming ? 'From' : 'To', value: d.counterparty });
  if (d.accountName) rows.push({ label: 'Account', value: d.accountName });
  if (d.date) rows.push({ label: 'Date', value: new Date(d.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) });
  if (d.balanceAfter != null) rows.push({ label: 'New balance', value: money(d.balanceAfter) });
  return {
    subject: (incoming ? 'Money received' : 'Payment posted') + ' — ' + money(mag),
    content: {
      preheader: (incoming ? 'A credit of ' : 'A debit of ') + money(mag) + ' posted to your account.',
      heading: incoming ? 'Money received' : 'Transaction posted',
      intro: greeting(user) + '<br>A ' + (incoming ? 'credit' : 'debit') + ' has posted to your <b>' + esc(BRAND.name) + '</b> account.',
      highlight: { amount: (incoming ? '+' : '−') + money(mag), label: incoming ? 'Credit' : 'Debit', color: incoming ? '#1a7f37' : BRAND.ink },
      rows: rows,
      cta: { label: 'View in your account', path: '/user/dashboard' },
      footerNote: 'If you don’t recognize this transaction, contact support right away.',
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
      cta: { label: 'Review recent activity', path: '/user/dashboard' },
      footerNote: 'If this wasn’t you, change your password and contact support immediately.',
    },
  };
}

// One-time passcode to finish signing in.
function buildLoginCode(user, d) {
  const ttl = Number(d && d.ttlMin) || 10;
  return {
    subject: 'Your sign-in code: ' + d.code,
    content: {
      preheader: 'Your one-time sign-in code is ' + d.code + '.',
      heading: 'Verify your sign-in',
      intro: greeting(user) + '<br>Use this one-time code to finish signing in to your <b>' + esc(BRAND.name) + '</b> account.',
      code: d.code,
      codeLabel: 'One-time code · expires in ' + ttl + ' minute' + (ttl === 1 ? '' : 's'),
      footerNote: 'If you didn’t try to sign in, do not share this code — and consider changing your password.',
    },
  };
}

// One-time passcode to reset a forgotten password.
function buildResetCode(user, d) {
  const ttl = Number(d && d.ttlMin) || 10;
  return {
    subject: 'Your password reset code: ' + d.code,
    content: {
      preheader: 'Your password reset code is ' + d.code + '.',
      heading: 'Reset your password',
      intro: greeting(user) + '<br>Enter this code to reset the password on your <b>' + esc(BRAND.name) + '</b> account.',
      code: d.code,
      codeLabel: 'Reset code · expires in ' + ttl + ' minute' + (ttl === 1 ? '' : 's'),
      footerNote: 'If you didn’t request a password reset, you can safely ignore this email — your password stays unchanged.',
    },
  };
}

// Confirmation that a password was changed.
function buildPasswordChanged(user, d) {
  const when = (d && d.when ? new Date(d.when) : new Date());
  return {
    subject: 'Your password was changed',
    content: {
      preheader: 'Your Alliance account password was just changed.',
      heading: 'Password changed',
      intro: greeting(user) + '<br>The password on your <b>' + esc(BRAND.name) + '</b> account was just changed.',
      rows: [{ label: 'When', value: when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) }],
      cta: { label: 'Sign in', path: '/login' },
      footerNote: 'If you didn’t make this change, contact support immediately.',
    },
  };
}

const BUILDERS = {
  transferSubmitted: buildTransferSubmitted,
  transferApproved: buildTransferApproved,
  transferRejected: buildTransferRejected,
  transactionPosted: buildTransactionPosted,
  login: buildLogin,
};

/* ---------- send ----------
   msg = { to, subject, content }. Renders HTML + text here so the logo source
   (hosted Site URL vs inline CID) and button links resolve from settings. */
async function sendRaw(settings, msg) {
  const { tx, live } = getTransporter(settings);
  // Logo is always referenced as a hosted image (no file attachment).
  const logoSrc = (settings.siteUrl || '') + logo.path;
  const from = fromHeader(settings);
  const mail = {
    from: from,
    replyTo: from,
    to: msg.to,
    subject: msg.subject,
    html: renderEmail(msg.content, { logoSrc: logoSrc, siteUrl: settings.siteUrl }),
    text: toText(msg.content, settings.siteUrl),
    headers: { 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
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
    return await sendRaw(settings, { to: user.email, subject: built.subject, content: built.content });
  } catch (e) {
    console.error('[email] sendEventEmail failed (non-fatal):', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

// Admin: send a custom message to a user, wrapped in the brand template.
async function sendCustomEmail(user, subject, message) {
  const settings = await getEmailSettings();
  const paras = String(message || '').split(/\n{2,}/).map(function (p) {
    return '<p style="margin:0 0 14px;font-size:14px;line-height:22px;color:#3f4a45;">' + esc(p).replace(/\n/g, '<br>') + '</p>';
  }).join('');
  const content = {
    preheader: subject,
    heading: subject,
    intro: greeting(user),
    bodyHtml: '<div style="margin-top:14px;">' + paras + '</div>',
  };
  return await sendRaw(settings, { to: user.email, subject: subject, content: content });
}

// Deliver a login/reset one-time code. Security-critical and always attempted
// (not gated by the per-event toggles). Still non-fatal to the caller.
async function sendCode(user, purpose, code, ttlMin) {
  if (!user || !user.email) return { ok: false, skipped: 'no-email' };
  const settings = await getEmailSettings();
  const built = purpose === 'reset'
    ? buildResetCode(user, { code: code, ttlMin: ttlMin })
    : buildLoginCode(user, { code: code, ttlMin: ttlMin });
  return await sendRaw(settings, { to: user.email, subject: built.subject, content: built.content });
}

// Confirmation email after a password change (best-effort, never throws).
async function sendPasswordChanged(user) {
  try {
    if (!user || !user.email) return { ok: false, skipped: 'no-email' };
    const settings = await getEmailSettings();
    const built = buildPasswordChanged(user, { when: new Date() });
    return await sendRaw(settings, { to: user.email, subject: built.subject, content: built.content });
  } catch (e) {
    console.error('[email] sendPasswordChanged failed (non-fatal):', e && e.message);
    return { ok: false, error: e && e.message };
  }
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
  return await sendRaw(settings, { to: to, subject: 'Test email — Alliance email settings', content: content });
}

module.exports = {
  DEFAULT_SETTINGS,
  getEmailSettings,
  saveEmailSettings,
  isConfigured,
  sendEventEmail,
  sendCustomEmail,
  sendTestEmail,
  sendCode,
  sendPasswordChanged,
  renderEmail, // exported for local preview/testing
  builders: BUILDERS, // exported for local preview/testing
};

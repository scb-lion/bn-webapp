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
  provider: 'auto', // 'auto' = Resend then Gmail SMTP fallback; 'resend' = Resend only; 'smtp' = Gmail SMTP only
  siteUrl: '', // e.g. https://your-site.vercel.app — used for hosted logo + button links
  // Resend HTTP API is the primary sender: mail goes out from a domain you've
  // verified in Resend, so SPF/DKIM/DMARC are handled there (far better inbox rate).
  resend: { apiKey: '', from: '' }, // from = a sender address on your verified domain, e.g. alerts@yourdomain.com
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: '', pass: '' }, // Gmail fallback
  from: { name: BRAND.name, email: '' }, // name = display name; email = optional Reply-To
  events: { transferSubmitted: true, transferApproved: true, transferRejected: true, transactionPosted: true, login: true },
};

function cleanUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }
function normalizeProvider(p) { return ['auto', 'resend', 'smtp'].indexOf(p) >= 0 ? p : 'auto'; }

/* ---------- settings ---------- */
async function getEmailSettings() {
  try {
    const { settings } = await collections();
    const doc = await settings.findOne({ _id: 'email' });
    if (!doc) return { ...DEFAULT_SETTINGS };
    return {
      enabled: doc.enabled !== false,
      provider: normalizeProvider(doc.provider),
      siteUrl: cleanUrl(doc.siteUrl || ''),
      resend: { ...DEFAULT_SETTINGS.resend, ...(doc.resend || {}) },
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
    provider: patch.provider !== undefined ? normalizeProvider(patch.provider) : current.provider,
    siteUrl: patch.siteUrl !== undefined ? cleanUrl(patch.siteUrl) : current.siteUrl,
    resend: {
      // keep the existing API key when the field comes through empty (masked in the UI)
      apiKey: (patch.resend && patch.resend.apiKey) ? String(patch.resend.apiKey).trim() : current.resend.apiKey,
      from: (patch.resend && patch.resend.from !== undefined) ? String(patch.resend.from).trim() : current.resend.from,
    },
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
function resendConfigured(s) {
  return !!(s && s.resend && s.resend.apiKey && s.resend.from);
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
// Build a `"Display Name" <email>` header, omitting the quoted name when none
// is set (falls back to the bare address).
function displayFrom(name, email) {
  const n = String(name || '').replace(/"/g, '').trim();
  if (!email) return n;
  return n ? '"' + n + '" <' + email + '>' : email;
}
// The From address is ALWAYS the authenticated SMTP (Gmail) account. Sending as
// the account we actually authenticate with keeps SPF, DKIM and DMARC aligned —
// the single biggest factor in landing in the inbox instead of spam. A custom
// From email would misalign (Gmail signs for gmail.com) and get foldered.
// The From name (display name) from settings is shown before the address.
function fromHeader(s) {
  const email = (s.smtp && s.smtp.user) || (s.from && s.from.email) || '';
  return displayFrom(s.from && s.from.name, email);
}
// Replies can still route to a different mailbox without hurting deliverability:
// Reply-To isn't authenticated, so a custom address here is safe.
function replyToHeader(s) {
  const custom = String((s.from && s.from.email) || '').trim();
  const sender = String((s.smtp && s.smtp.user) || '').trim();
  if (custom && custom.toLowerCase() !== sender.toLowerCase()) return displayFrom(s.from && s.from.name, custom);
  return fromHeader(s);
}
// Bare reply-to address (Resend's reply_to takes a plain email, not a header).
function replyToEmail(s) {
  return String((s.from && s.from.email) || '').trim();
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


  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';-webkit-font-smoothing:antialiased;">' +
    // Suppressed preview text — invisible filler so no snippet leaks into the inbox list.
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">' + '&#8203;&nbsp;'.repeat(60) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.bg + ';padding:28px 12px;">' +
    '<tr><td align="center">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(16,60,40,.10);">' +
        // slim top bar — no logo, no brand name (kept intentionally unbranded)
        '<tr><td style="height:6px;line-height:6px;font-size:0;background:' + BRAND.green + ';">&nbsp;</td></tr>' +
        // body
        '<tr><td style="padding:32px 32px 28px;' + FONT + 'color:' + BRAND.ink + ';">' +
          (c.heading ? '<h1 style="margin:0 0 8px;font-size:21px;font-weight:800;color:' + BRAND.ink + ';letter-spacing:-.3px;">' + esc(c.heading) + '</h1>' : '') +
          (c.intro ? '<p style="margin:0;font-size:14px;line-height:22px;color:#3f4a45;">' + c.intro + '</p>' : '') +
          (c.bodyHtml || '') +
          codeBlock + highlight + table + cta +
          (c.footerNote ? '<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:' + BRAND.muted + ';">' + c.footerNote + '</p>' : '') +
        '</td></tr>' +
        // footer — no brand name, no domain
        '<tr><td style="padding:18px 32px 24px;background:#f7faf8;border-top:1px solid ' + BRAND.line + ';' + FONT + '">' +
          '<p style="margin:0;font-size:11px;line-height:16px;color:#9aa0a6;">This is an automated message about your account. This inbox isn’t monitored, so please don’t reply.</p>' +
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
  lines.push('', 'This is an automated message. Please do not reply.');
  return lines.join('\n');
}

function greeting(user) {
  const name = (user && user.profile && (user.profile.firstName || user.profile.displayName)) || (user && user.username) || 'there';
  return 'Hi ' + esc(name) + ',';
}

/* ---------- per-event content ---------- */

function buildTransferSubmitted(user, d) {
  return {
    subject: 'We received your request',
    content: {
      preheader: 'We’ve received your request.',
      heading: 'Request received',
      intro: greeting(user) + '<br>We’ve received your request and it’s now in progress. We’ll send you an update once it’s ready.',
      rows: [{ label: 'Status', value: 'Pending' }],
      footerNote: 'If you didn’t make this request, let us know.',
    },
  };
}

function buildTransferApproved(user, d) {
  return {
    subject: 'Your request is complete',
    content: {
      preheader: 'Your request is complete.',
      heading: 'Request complete',
      intro: greeting(user) + '<br>Your request is now complete.',
      rows: [{ label: 'Status', value: 'Completed' }],
    },
  };
}

function buildTransferRejected(user, d) {
  return {
    subject: 'Your request could not be completed',
    content: {
      preheader: 'Your request could not be completed.',
      heading: 'Request not completed',
      intro: greeting(user) + '<br>Your request could not be completed. If you have any questions, we’re here to help.',
      rows: [{ label: 'Status', value: 'Not completed' }],
    },
  };
}

// An update the admin posted directly to the account.
function buildTransactionPosted(user, d) {
  const rows = [];
  if (d.date) rows.push({ label: 'Date', value: new Date(d.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) });
  return {
    subject: 'A recent update to your account',
    content: {
      preheader: 'There’s a new update on your account.',
      heading: 'Account update',
      intro: greeting(user) + '<br>There’s a new update on your account.',
      rows: rows,
      footerNote: 'If this doesn’t look right, let us know.',
    },
  };
}

function buildLogin(user, d) {
  const when = d && d.when ? new Date(d.when) : new Date();
  return {
    subject: 'Recent sign-in to your account',
    content: {
      preheader: 'A recent sign-in to your account.',
      heading: 'Recent sign-in',
      intro: greeting(user) + '<br>Your account was just signed in to. If this was you, there’s nothing you need to do.',
      rows: [{ label: 'When', value: when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) }],
      footerNote: 'If this wasn’t you, you can change your password anytime in Settings.',
    },
  };
}

// One-time passcode to finish signing in.
function buildLoginCode(user, d) {
  const ttl = Number(d && d.ttlMin) || 10;
  return {
    subject: 'Your sign-in code',
    content: {
      preheader: 'Enter this code to finish signing in.',
      heading: 'Your sign-in code',
      intro: greeting(user) + '<br>Enter this code to finish signing in to your account.',
      code: d.code,
      codeLabel: 'Expires in ' + ttl + ' minute' + (ttl === 1 ? '' : 's'),
      footerNote: 'If you didn’t try to sign in, you can ignore this email. Please keep this code to yourself.',
    },
  };
}

// One-time passcode to reset a forgotten password.
function buildResetCode(user, d) {
  const ttl = Number(d && d.ttlMin) || 10;
  return {
    subject: 'Your password reset code',
    content: {
      preheader: 'Enter this code to reset your password.',
      heading: 'Reset your password',
      intro: greeting(user) + '<br>Enter this code to reset the password on your account.',
      code: d.code,
      codeLabel: 'Expires in ' + ttl + ' minute' + (ttl === 1 ? '' : 's'),
      footerNote: 'If you didn’t request this, you can ignore this email — your password won’t change.',
    },
  };
}

// Confirmation that a password was changed.
function buildPasswordChanged(user, d) {
  const when = (d && d.when ? new Date(d.when) : new Date());
  return {
    subject: 'Your password was updated',
    content: {
      preheader: 'The password on your account was updated.',
      heading: 'Password updated',
      intro: greeting(user) + '<br>The password on your account was just updated.',
      rows: [{ label: 'When', value: when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) }],
      footerNote: 'If you didn’t make this change, please get in touch with us.',
    },
  };
}

// Invite a spouse/partner to become a joint holder. `invite` is the invites doc
// (unused for now — kept in the signature per the shared build contract in case
// a future revision wants invite-specific copy); `link` is the personal,
// token-bearing join URL; `primaryName` is the account holder's display name.
function buildJointInvite(invite, link, primaryName) {
  const name = esc(primaryName || 'The primary account holder');
  return {
    subject: 'You’ve been invited to join an account',
    content: {
      preheader: 'You’ve been invited to join an account.',
      heading: 'You’re invited',
      intro: 'Hi,<br>' + name + ' has invited you to become a joint holder on their account. Use the link below to get started — it’s personal to you.',
      bodyHtml: '<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#3f4a45;word-break:break-all;"><a href="' + esc(link) + '" style="color:' + BRAND.green + ';font-weight:700;">' + esc(link) + '</a></p>',
      cta: { label: 'Continue', url: link },
      footerNote: 'This link expires in 7 days. If you weren’t expecting this invite, you can ignore this email.',
    },
  };
}

// Notice that a joint application was approved.
function buildJointApproved(user, d) {
  return {
    subject: 'Your joint account access is approved',
    content: {
      preheader: 'Your joint account access has been approved.',
      heading: 'You’re approved',
      intro: greeting(user) + '<br>Your joint account application has been approved. You can sign in now to view and manage the account.',
      footerNote: 'If you have any questions, we’re here to help.',
    },
  };
}

// Notice that a joint application was rejected.
function buildJointRejected(user, d) {
  const reason = String((d && d.reason) || '').trim();
  return {
    subject: 'An update on your joint account application',
    content: {
      preheader: 'An update on your joint account application.',
      heading: 'Application not approved',
      intro: greeting(user) + '<br>We weren’t able to approve your joint account application.',
      rows: reason ? [{ label: 'Reason', value: reason }] : [],
      footerNote: 'If you have any questions, please get in touch with us.',
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
// Send through the Resend HTTP API. Throws on any non-2xx so the caller can fall
// back to SMTP. `from` is the verified-domain sender — that's what makes the
// message authenticate (SPF/DKIM/DMARC handled by Resend for that domain).
async function sendViaResend(settings, m) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable');
  const payload = {
    from: displayFrom(settings.from && settings.from.name, settings.resend.from),
    to: [m.to],
    subject: m.subject,
    html: m.html,
    text: m.text,
    headers: { 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
  };
  const reply = replyToEmail(settings);
  if (reply) payload.reply_to = reply;
  if (m.inlineLogo) {
    payload.attachments = [{ filename: m.inlineLogo.filename, content: m.inlineLogo.base64, content_id: m.inlineLogo.cid, content_type: m.inlineLogo.contentType }];
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let resp, body;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.resend.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    body = await resp.text();
  } finally { clearTimeout(timer); }
  if (!resp.ok) throw new Error('Resend HTTP ' + resp.status + ': ' + String(body).slice(0, 300));
  try { return JSON.parse(body); } catch { return { id: '' }; }
}

async function sendRaw(settings, msg) {
  // The template no longer renders a logo, so nothing is attached — an orphaned
  // CID image would otherwise surface as a stray attachment in some clients.
  const html = renderEmail(msg.content, { siteUrl: settings.siteUrl });
  const text = toText(msg.content, settings.siteUrl);
  // provider: 'auto' (Resend then SMTP fallback), 'resend' (Resend only), or
  // 'smtp' (Gmail SMTP only) — lets an admin isolate one sender for testing.
  const provider = settings.provider || 'auto';

  // 1) Resend HTTP API — used unless the admin forced Gmail SMTP.
  if (provider !== 'smtp' && resendConfigured(settings)) {
    try {
      const info = await sendViaResend(settings, { to: msg.to, subject: msg.subject, html: html, text: text });
      console.log('[email] sent via Resend to=%s subject=%s id=%s', msg.to, msg.subject, (info && info.id) || '');
      return { ok: true, live: true, via: 'resend', info: info };
    } catch (e) {
      console.error('[email] Resend send failed (%s)%s', e && e.message, provider === 'resend' ? '' : ' — falling back to SMTP');
      if (provider === 'resend') throw e; // forced Resend: surface the error, never fall back
    }
  }

  // Forced Resend but not configured: nothing to send — preview instead of
  // quietly falling through to SMTP (which would defeat the isolated test).
  if (provider === 'resend') {
    console.log('[email] (preview — Resend selected but not configured) to=%s subject=%s', msg.to, msg.subject);
    return { ok: true, live: false, via: 'preview', info: null };
  }

  // 2) Gmail SMTP — 'smtp' mode, or the fallback/preview path for 'auto'.
  const { tx, live } = getTransporter(settings);
  const mail = {
    from: fromHeader(settings),
    replyTo: replyToHeader(settings),
    to: msg.to,
    subject: msg.subject,
    html: html,
    text: text,
    headers: { 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
  };
  const info = await tx.sendMail(mail);
  if (!live) console.log('[email] (preview — no live transport) to=%s subject=%s', msg.to, msg.subject);
  else console.log('[email] sent via SMTP to=%s subject=%s id=%s', msg.to, msg.subject, info.messageId);
  return { ok: true, live: live, via: live ? 'smtp' : 'preview', info: info };
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

// Shared content for an admin's custom message, wrapped in the brand template.
function buildCustomContent(user, subject, message) {
  const paras = String(message || '').split(/\n{2,}/).map(function (p) {
    return '<p style="margin:0 0 14px;font-size:14px;line-height:22px;color:#3f4a45;">' + esc(p).replace(/\n/g, '<br>') + '</p>';
  }).join('');
  return {
    preheader: subject,
    heading: subject,
    intro: greeting(user),
    bodyHtml: '<div style="margin-top:14px;">' + paras + '</div>',
  };
}

// Admin: send a custom message to a user, wrapped in the brand template.
async function sendCustomEmail(user, subject, message) {
  const settings = await getEmailSettings();
  return await sendRaw(settings, { to: user.email, subject: subject, content: buildCustomContent(user, subject, message) });
}

// Admin: render the branded HTML for a custom message without sending it — used
// by the "Copy HTML" preview so the copied markup matches exactly what's sent.
async function renderCustomEmail(user, subject, message) {
  const settings = await getEmailSettings();
  // Copied HTML is pasted into other tools (an ESP editor, a preview) where no
  // CID attachment exists — so embed the logo as a data URI to stay self-contained.
  const logoSrc = settings.siteUrl ? settings.siteUrl + logo.path : logo.dataUri();
  return renderEmail(buildCustomContent(user, subject, message), { logoSrc: logoSrc, siteUrl: settings.siteUrl });
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

// Admin: send the invite link to the spouse/partner being invited. Non-fatal —
// the invite still gets created even if the send fails.
async function sendJointInvite(toEmail, link, primaryName) {
  const settings = await getEmailSettings();
  const built = buildJointInvite(null, link, primaryName);
  return await sendRaw(settings, { to: toEmail, subject: built.subject, content: built.content });
}

// Notify the spouse their joint application was approved (best-effort, never throws).
async function sendJointApproved(user) {
  try {
    if (!user || !user.email) return { ok: false, skipped: 'no-email' };
    const settings = await getEmailSettings();
    const built = buildJointApproved(user, {});
    return await sendRaw(settings, { to: user.email, subject: built.subject, content: built.content });
  } catch (e) {
    console.error('[email] sendJointApproved failed (non-fatal):', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

// Notify the spouse their joint application was rejected (best-effort, never throws).
async function sendJointRejected(user, reason) {
  try {
    if (!user || !user.email) return { ok: false, skipped: 'no-email' };
    const settings = await getEmailSettings();
    const built = buildJointRejected(user, { reason: reason });
    return await sendRaw(settings, { to: user.email, subject: built.subject, content: built.content });
  } catch (e) {
    console.error('[email] sendJointRejected failed (non-fatal):', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

// Which transport sendRaw will use for these settings, and the From address it
// sends with — so the test email body matches the real sender (not the old
// hardcoded SMTP/Gmail wording).
function activeTransport(s) {
  const provider = s.provider || 'auto';
  const name = s.from && s.from.name;
  if (provider !== 'smtp' && resendConfigured(s)) return { via: 'Resend', from: displayFrom(name, s.resend.from) };
  if (provider === 'resend') return { via: 'Preview (Resend selected but not configured)', from: displayFrom(name, s.resend.from || '') };
  if (isConfigured(s)) return { via: 'Gmail SMTP', from: fromHeader(s) };
  return { via: 'Preview (no live sender configured)', from: fromHeader(s) };
}

// Admin: verify email delivery with a self-addressed test email.
async function sendTestEmail(to) {
  const settings = await getEmailSettings();
  const t = activeTransport(settings);
  const content = {
    preheader: 'Your email delivery is working.',
    heading: 'Email delivery is working',
    intro: 'This is a test message from your admin panel. If you can read this, your email settings are working.',
    rows: [
      { label: 'Sent via', value: t.via },
      { label: 'From', value: t.from },
      { label: 'Sent', value: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) },
    ],
  };
  return await sendRaw(settings, { to: to, subject: 'Email settings test', content: content });
}

module.exports = {
  DEFAULT_SETTINGS,
  getEmailSettings,
  saveEmailSettings,
  isConfigured,
  resendConfigured,
  sendEventEmail,
  sendCustomEmail,
  renderCustomEmail,
  sendTestEmail,
  sendCode,
  sendPasswordChanged,
  buildJointInvite,
  buildJointApproved,
  buildJointRejected,
  sendJointInvite,
  sendJointApproved,
  sendJointRejected,
  renderEmail, // exported for local preview/testing
  builders: BUILDERS, // exported for local preview/testing
};

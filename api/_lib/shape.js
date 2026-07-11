// Serialization helpers shared by API routes. Money is stored as integer cents
// everywhere; formatting to dollars happens on the client.

function publicUser(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    username: user.username,
    email: user.email || '',
    role: user.role,
    active: user.active !== false,
    profile: {
      firstName: user.profile?.firstName || '',
      displayName: user.profile?.displayName || user.profile?.firstName || user.username,
      photoUrl: user.profile?.photoUrl || '/assets/img/default-avatar.png',
      phone: user.profile?.phone || '',
      address: user.profile?.address || '',
    },
    accounts: (user.accounts || []).map(publicAccount),
    zelle: {
      contact: (user.zelle && user.zelle.contact) || '',
      defaultAccountId: (user.zelle && user.zelle.defaultAccountId) || '',
    },
    zelleRecipients: (user.zelleRecipients || []).map(publicRecipient),
    security: {
      otpLogin: (user.security && user.security.otpLogin) || 'default', // 'default' | 'on' | 'off'
    },
    createdAt: user.createdAt || null,
    joint: user.jointOf
      ? { status: user.jointStatus || 'pending', primaryName: '' } // primaryName filled by me.js
      : null,
  };
}

function publicRecipient(r) {
  return {
    id: String(r.id || ''),
    name: r.name || '',
    contact: r.contact || '',
  };
}

function publicAccount(a) {
  return {
    id: a.id,
    type: a.type || 'Checking',
    number: a.number || '',
    name: a.name || a.type || 'Account',
    balance: Number.isFinite(a.balance) ? a.balance : 0, // cents
  };
}

function publicTxn(t) {
  return {
    id: String(t._id),
    accountId: t.accountId,
    ref: t.ref || '',
    date: t.date ? new Date(t.date).toISOString() : null,
    description: t.description || '',
    counterparty: t.counterparty || '',
    amount: Number.isFinite(t.amount) ? t.amount : 0, // signed cents
    type: t.type || (t.amount >= 0 ? 'credit' : 'debit'),
    balanceAfter: Number.isFinite(t.balanceAfter) ? t.balanceAfter : null,
    status: t.status || 'completed', // 'pending' | 'completed' | 'rejected'
    kind: t.kind || '', // '' | 'internal' | 'domestic' | 'wire' | 'zelle' | 'deposit'
    transferId: t.transferId || '',
    meta: t.meta && typeof t.meta === 'object' ? t.meta : null,
  };
}

module.exports = { publicUser, publicAccount, publicTxn, publicRecipient };

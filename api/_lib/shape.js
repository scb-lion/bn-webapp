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
      photoUrl: user.profile?.photoUrl || '/assets/img/dp/Angeline1782480359.jpeg',
      phone: user.profile?.phone || '',
      address: user.profile?.address || '',
    },
    accounts: (user.accounts || []).map(publicAccount),
    createdAt: user.createdAt || null,
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
  };
}

module.exports = { publicUser, publicAccount, publicTxn };

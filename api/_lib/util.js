// Convert a dollar amount (number or string like "1,500.50") to integer cents.
function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function randomId(len = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function genRef() {
  return 'ref_' + randomId(12).toLowerCase();
}

function genTransferId() {
  return 'tr_' + randomId(14).toLowerCase();
}

// A short account id/number if the admin doesn't supply one.
function genAccountId() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = { toCents, randomId, genRef, genTransferId, genAccountId };

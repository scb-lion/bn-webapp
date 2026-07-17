// Seeds the demo customer "Mikaylah Anne Street" (username Mikaylah01) with five
// accounts (no loan) totalling exactly A$3,000,000, and ~3.5 months of recent
// transaction history (Apr–Jul 2026): payroll ACH, mobile deposits, wire,
// Zelle, dividends and interest. Melbourne / Victoria address.
//
// Run once locally (reads MONGODB_URI / MONGODB_DB from .env.local, then .env):
//   node scripts/seed-mikaylah.js
//
// Idempotent: upserts the user by username and REPLACES that user's transactions
// with a freshly generated set. It never touches any other user.
//
// Each account's opening deposit is computed as the exact balancing figure so the
// running balance lands on the requested target to the cent.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

const USERNAME = 'mikaylah01';
const PASSWORD = 'Anonymous123$';
const EMAIL = 'mikaylah.street@gmail.com';
const PROFILE = {
  firstName: 'Mikaylah',
  displayName: 'Mikaylah Anne Street',
  photoUrl: '',
  phone: '+61 412 555 087',
  address: '27 Separation Street, Northcote, Melbourne VIC 3078, Australia',
};
const CREATED_AT = new Date(Date.UTC(2015, 5, 10, 3, 0, 0)); // account opened 2015-06-10

// ---- accounts (balance filled in from the transactions below) ---------------
const CHECKING = { id: 'chk-6710', type: 'Checking', number: '6710', name: 'Everyday Checking' };
const SAVINGS = { id: 'sav-2245', type: 'Savings', number: '2245', name: 'Premier Savings' };
const INVEST = { id: 'inv-9034', type: 'Investment', number: '9034', name: 'Investment Account' };
const TERM = { id: 'trm-5561', type: 'Term Deposit', number: '5561', name: 'Term Deposit' };
const SAVER = { id: 'hisa-8802', type: 'Savings', number: '8802', name: 'High Interest Saver' };

// target balances (dollars) — total 3,000,000
const TARGET = {
  [CHECKING.id]: 12000,
  [SAVINGS.id]: 480000,
  [INVEST.id]: 1850000,
  [TERM.id]: 600000,
  [SAVER.id]: 58000,
};

// ---- helpers ----------------------------------------------------------------
const cents = (d) => Math.round(d * 100);
const genRef = () => 'ref_' + Math.random().toString(36).slice(2, 14);
const genTransferId = () => 'tr_' + Math.random().toString(36).slice(2, 16);
const genRecipientId = () => 'rcp_' + Math.random().toString(36).slice(2, 12);
// deterministic UTC date
const D = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h == null ? 3 : h, (d * 7) % 60, 0));

// ---- Zelle enrollment + saved recipients ------------------------------------
const ZELLE = { contact: EMAIL, defaultAccountId: CHECKING.id };
const ZELLE_RECIPIENTS = [
  { name: 'Chloe Bennett', contact: 'chloe.bennett@gmail.com' },
  { name: 'Liam Nguyen', contact: '(03) 9555 0142' },
  { name: 'Olivia Hughes', contact: 'olivia.hughes@outlook.com' },
  { name: 'Noah Fraser', contact: '(04) 1255 0198' },
].map((r) => ({ id: genRecipientId(), ...r }));

// movement rows: [date, description, counterparty, signedDollars, extra?]
// extra may carry { kind, mode, contact } for Zelle/wire/deposit tagging.
const CHECKING_MOVES = [
  [D(2026, 4, 1), 'ACH Direct Deposit — LANTERN MEDIA PAYROLL', 'Lantern Media', 8500.0],
  [D(2026, 4, 4), 'Mobile Check Deposit', 'Mobile Deposit', 1200.0, { kind: 'deposit' }],
  [D(2026, 4, 9), 'Grocery Purchase', 'Woolworths', -186.4],
  [D(2026, 4, 12), 'Zelle Received', 'Chloe Bennett', 400.0, { kind: 'zelle', mode: 'request', contact: 'chloe.bennett@gmail.com' }],
  [D(2026, 4, 15), 'ACH Payment — AGL Energy', 'AGL', -240.3],
  [D(2026, 4, 20), 'Zelle Payment', 'Liam Nguyen', -175.0, { kind: 'zelle', mode: 'send', contact: '(03) 9555 0142' }],
  [D(2026, 4, 24), 'Fuel', 'BP', -78.2],
  [D(2026, 5, 1), 'ACH Direct Deposit — LANTERN MEDIA PAYROLL', 'Lantern Media', 8500.0],
  [D(2026, 5, 5), 'Wire Transfer Received', 'Westpac Banking Corp', 6000.0, { kind: 'wire' }],
  [D(2026, 5, 10), 'Rent Payment', 'Northcote Property Group', -2400.0],
  [D(2026, 5, 14), 'Grocery Purchase', 'Coles', -142.1],
  [D(2026, 5, 18), 'Zelle Payment', 'Olivia Hughes', -220.0, { kind: 'zelle', mode: 'send', contact: 'olivia.hughes@outlook.com' }],
  [D(2026, 5, 26), 'Mobile Check Deposit', 'Mobile Deposit', 950.0, { kind: 'deposit' }],
  [D(2026, 6, 1), 'ACH Direct Deposit — LANTERN MEDIA PAYROLL', 'Lantern Media', 8500.0],
  [D(2026, 6, 6), 'ACH Payment — Telstra', 'Telstra', -95.0],
  [D(2026, 6, 12), 'Restaurant', 'Cutler & Co', -88.5],
  [D(2026, 6, 17), 'Zelle Received', 'Noah Fraser', 260.0, { kind: 'zelle', mode: 'request', contact: '(04) 1255 0198' }],
  [D(2026, 6, 23), 'Grocery Purchase', 'Woolworths', -168.75],
  [D(2026, 7, 1), 'ACH Direct Deposit — LANTERN MEDIA PAYROLL', 'Lantern Media', 8500.0],
  [D(2026, 7, 8), 'Wire Transfer Sent', 'Continental Realty', -3500.0, { kind: 'wire' }],
  [D(2026, 7, 12), 'Fuel', 'Shell', -70.4],
];

const SAVINGS_MOVES = [
  [D(2026, 4, 6), 'Interest Payment', '', 720.0],
  [D(2026, 4, 22), 'Transfer from Everyday Checking', 'Everyday Checking ••6710', 5000.0],
  [D(2026, 5, 8), 'Interest Payment', '', 735.0],
  [D(2026, 5, 28), 'Mobile Check Deposit', 'Mobile Deposit', 3000.0, { kind: 'deposit' }],
  [D(2026, 6, 9), 'Interest Payment', '', 740.0],
  [D(2026, 6, 30), 'Transfer from Everyday Checking', 'Everyday Checking ••6710', 4000.0],
  [D(2026, 7, 10), 'Interest Payment', '', 745.0],
];

const INVEST_MOVES = [
  [D(2026, 4, 3), 'Investment Deposit', 'Brokerage Funding', 80000.0],
  [D(2026, 4, 18), 'Dividend Reinvestment', 'Portfolio', 5200.0],
  [D(2026, 5, 6), 'Wire Transfer Received', 'Vanguard Investments', 150000.0, { kind: 'wire' }],
  [D(2026, 5, 20), 'Investment Deposit', 'Brokerage Funding', 95000.0],
  [D(2026, 6, 4), 'Dividend Payment', 'Portfolio', 6400.0],
  [D(2026, 6, 24), 'Investment Deposit', 'Brokerage Funding', 70000.0],
  [D(2026, 7, 7), 'Capital Gains Distribution', 'Portfolio', 11800.0],
];

const TERM_MOVES = [
  [D(2026, 4, 1), 'Term Deposit Interest', '', 6000.0],
  [D(2026, 5, 1), 'Term Deposit Interest', '', 6050.0],
  [D(2026, 6, 1), 'Term Deposit Interest', '', 6100.0],
  [D(2026, 7, 1), 'Term Deposit Interest', '', 6150.0],
];

const SAVER_MOVES = [
  [D(2026, 4, 10), 'Interest Payment', '', 190.0],
  [D(2026, 4, 26), 'Mobile Check Deposit', 'Mobile Deposit', 2000.0, { kind: 'deposit' }],
  [D(2026, 5, 15), 'Interest Payment', '', 195.0],
  [D(2026, 6, 14), 'Transfer from Everyday Checking', 'Everyday Checking ••6710', 3000.0],
  [D(2026, 6, 29), 'Interest Payment', '', 198.0],
  [D(2026, 7, 14), 'Mobile Check Deposit', 'Mobile Deposit', 1500.0, { kind: 'deposit' }],
];

// Build transaction docs for one account with a correct running balanceAfter.
// The opening deposit (dated at account creation) is the exact balancing figure
// so the final balance equals the requested target to the cent.
function build(account, openingDesc, moves) {
  const targetCents = cents(TARGET[account.id]);
  const rows = moves.map((m) => ({ date: m[0], description: m[1], counterparty: m[2], amount: cents(m[3]), extra: m[4] || {} }));
  const sumMoves = rows.reduce((s, r) => s + r.amount, 0);
  rows.push({ date: CREATED_AT, description: openingDesc, counterparty: '', amount: targetCents - sumMoves, extra: {} });
  rows.sort((a, b) => a.date - b.date); // oldest first

  let balance = 0;
  const txns = rows.map((r) => {
    const status = r.extra.status || 'completed';
    balance += r.amount;
    const doc = {
      accountId: account.id,
      ref: genRef(),
      date: r.date,
      description: r.description,
      counterparty: r.counterparty,
      amount: r.amount, // signed cents
      type: r.amount >= 0 ? 'credit' : 'debit',
      balanceAfter: balance,
      status,
    };
    if (r.extra.kind) {
      doc.kind = r.extra.kind;
      doc.transferId = genTransferId();
      const mm = {};
      if (r.extra.contact) mm.contact = r.extra.contact;
      if (r.extra.mode) mm.mode = r.extra.mode;
      doc.meta = mm;
    }
    return doc;
  });
  return { txns, finalBalance: balance };
}

function buildData() {
  const built = {
    [CHECKING.id]: build(CHECKING, 'Opening Deposit', CHECKING_MOVES),
    [SAVINGS.id]: build(SAVINGS, 'Opening Deposit', SAVINGS_MOVES),
    [INVEST.id]: build(INVEST, 'Initial Investment Funding', INVEST_MOVES),
    [TERM.id]: build(TERM, 'Term Deposit Funding', TERM_MOVES),
    [SAVER.id]: build(SAVER, 'Opening Deposit', SAVER_MOVES),
  };
  const accounts = [CHECKING, SAVINGS, INVEST, TERM, SAVER].map((a) => ({ ...a, balance: built[a.id].finalBalance }));
  const txns = [].concat(...Object.values(built).map((b) => b.txns));
  return { accounts, txns, built };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (put it in .env.local)');
  const dbName = process.env.MONGODB_DB || 'alliance';

  const { accounts, txns } = buildData();

  const client = await MongoClient.connect(uri);
  try {
    const db = client.db(dbName);
    const users = db.collection('users');
    const transactions = db.collection('transactions');
    await users.createIndex({ username: 1 }, { unique: true });
    await transactions.createIndex({ userId: 1, date: -1 });

    const now = new Date();
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const existing = await users.findOne({ username: USERNAME });
    let userId;
    const set = {
      email: EMAIL, role: 'user', active: true, profile: PROFILE, accounts,
      zelle: ZELLE, zelleRecipients: ZELLE_RECIPIENTS, passwordHash,
      createdAt: CREATED_AT, updatedAt: now,
    };
    if (existing) {
      userId = existing._id;
      await users.updateOne({ _id: userId }, { $set: set });
      console.log(`Updated existing user "${USERNAME}" (id ${userId}).`);
    } else {
      const res = await users.insertOne({ username: USERNAME, ...set });
      userId = res.insertedId;
      console.log(`Created user "${USERNAME}" (id ${userId}).`);
    }

    const removed = await transactions.deleteMany({ userId });
    await transactions.insertMany(txns.map((t) => ({ ...t, userId })));

    const fmt = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    console.log(`  cleared ${removed.deletedCount} old transaction(s), inserted ${txns.length} new.`);
    accounts.forEach((a) => console.log(`  ${a.name.padEnd(22)} (${a.number})  ${fmt(a.balance)}`));
    console.log(`  ${''.padEnd(22)}  TOTAL  ${fmt(accounts.reduce((s, a) => s + a.balance, 0))}`);
    console.log(`\nLog in at /login  ->  username: ${USERNAME}   password: ${PASSWORD}`);
  } finally {
    await client.close();
  }
}

module.exports = { buildData, TARGET, CHECKING, SAVINGS, INVEST, TERM, SAVER };

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}

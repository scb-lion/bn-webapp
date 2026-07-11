// Seeds the demo customer "Robert Darrell" (username Robert01) with five accounts
// and ~2 months of 2008 transaction history (mobile deposits, ACH, investment
// deposits, wire, Zelle), followed by an annual bank charge every year since.
// The account is dated as opened in 1998; the last customer activity is 2008 and
// the only movement after that is the yearly maintenance/dormant-account fee.
//
// Run once locally (reads MONGODB_URI / MONGODB_DB from .env.local, then .env):
//   node scripts/seed-robert.js
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

const USERNAME = 'robert01';
const PASSWORD = '1980Rob07$';
const EMAIL = 'ms.consumerereport@gmail.com';
const PROFILE = {
  firstName: 'Robert',
  displayName: 'Robert Darrell',
  photoUrl: '',
  phone: '+1 (312) 555-0148',
  address: '1147 Lakeview Terrace, Chicago, IL 60614',
};
const CREATED_AT = new Date(Date.UTC(1998, 2, 15, 14, 0, 0)); // account opened 1998-03-15

// ---- accounts (balance filled in from the transactions below) ---------------
const CHECKING = { id: 'chk-4021', type: 'Checking', number: '4021', name: 'Everyday Checking' };
const JESSICA = { id: 'jes-3307', type: "Jessica's Account", number: '3307', name: "Jessica's Account" };
const INVEST = { id: 'inv-8890', type: 'Investment', number: '8890', name: 'Investment Account' };
const SAVINGS = { id: 'sav-7788', type: 'Savings', number: '7788', name: 'Premier Savings' };
const LOAN = { id: 'loan-5540', type: 'Loan', number: '5540', name: 'Loan Account' };

// target balances (dollars)
const TARGET = {
  [CHECKING.id]: 4300,
  [JESSICA.id]: 37000,
  [INVEST.id]: 959000,
  [SAVINGS.id]: 800000,
  [LOAN.id]: -80000,
};

// ---- helpers ----------------------------------------------------------------
const cents = (d) => Math.round(d * 100);
const genRef = () => 'ref_' + Math.random().toString(36).slice(2, 14);
const genTransferId = () => 'tr_' + Math.random().toString(36).slice(2, 16);
const genRecipientId = () => 'rcp_' + Math.random().toString(36).slice(2, 12);
// deterministic UTC date
const D = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h == null ? 14 : h, (d * 7) % 60, 0));

// ---- Zelle enrollment + saved recipients ------------------------------------
const ZELLE = { contact: EMAIL, defaultAccountId: CHECKING.id };
const ZELLE_RECIPIENTS = [
  { name: 'John Meyer', contact: 'john.meyer88@gmail.com' },
  { name: 'Maria Lopez', contact: '(312) 555-0148' },
  { name: 'David Chen', contact: 'd.chen@outlook.com' },
  { name: 'Ashley Turner', contact: '(773) 555-0173' },
].map((r) => ({ id: genRecipientId(), ...r }));

// An annual bank charge on Dec 20 each year, startYear..endYear inclusive.
function annualCharges(desc, dollars, startYear, endYear) {
  const out = [];
  for (let y = startYear; y <= endYear; y++) out.push([D(y, 12, 20), desc, 'Alliance Federal Credit Union', dollars]);
  return out;
}

// movement rows: [date, description, counterparty, signedDollars, extra?]
// extra may carry { kind, mode, contact } for Zelle/wire/deposit tagging.
const CHECKING_MOVES = [
  [D(2008, 9, 2), 'ACH Direct Deposit — MERIDIAN CORP PAYROLL', 'Meridian Corp', 3200.0],
  [D(2008, 9, 5), 'Mobile Check Deposit', 'Mobile Deposit', 1250.0, { kind: 'deposit' }],
  [D(2008, 9, 8), 'Wire Transfer Received', 'First National Bank', 5000.0, { kind: 'wire' }],
  [D(2008, 9, 10), 'Mortgage Payment', 'Lakeview Mortgage', -1800.0],
  [D(2008, 9, 12), 'Grocery Purchase', 'Jewel-Osco', -142.35],
  [D(2008, 9, 15), 'Zelle Received', 'John Meyer', 300.0, { kind: 'zelle', mode: 'request', contact: 'john.meyer88@gmail.com' }],
  [D(2008, 9, 18), 'ACH Payment — ComEd Utilities', 'ComEd', -210.4],
  [D(2008, 9, 20), 'Zelle Payment', 'Maria Lopez', -150.0, { kind: 'zelle', mode: 'send', contact: '(312) 555-0148' }],
  [D(2008, 9, 25), 'Mobile Check Deposit', 'Mobile Deposit', 900.0, { kind: 'deposit' }],
  [D(2008, 9, 28), 'Fuel', 'Shell', -64.8],
  [D(2008, 10, 1), 'ACH Direct Deposit — MERIDIAN CORP PAYROLL', 'Meridian Corp', 3200.0],
  [D(2008, 10, 3), 'Wire Transfer Sent', 'Continental Realty', -4500.0, { kind: 'wire' }],
  [D(2008, 10, 6), 'Zelle Payment', 'David Chen', -220.0, { kind: 'zelle', mode: 'send', contact: 'd.chen@outlook.com' }],
  [D(2008, 10, 9), 'Restaurant', 'The Purple Pig', -88.2],
  [D(2008, 10, 12), 'Mobile Check Deposit', 'Mobile Deposit', 1100.0, { kind: 'deposit' }],
  [D(2008, 10, 15), 'ACH Payment — State Farm Insurance', 'State Farm', -320.0],
  [D(2008, 10, 18), 'Grocery Purchase', 'Whole Foods Market', -130.9],
  [D(2008, 10, 22), 'Zelle Received', 'Ashley Turner', 180.0, { kind: 'zelle', mode: 'request', contact: '(773) 555-0173' }],
  [D(2008, 10, 27), 'Fuel', 'BP', -70.15],
  [D(2008, 10, 30), 'ACH Payment — AT&T Wireless', 'AT&T', -95.0],
  ...annualCharges('Annual Account Maintenance Fee', -50.0, 2009, 2025),
];

const JESSICA_MOVES = [
  [D(2008, 9, 3), 'ACH Deposit — Rental Income', 'Greystone Property', 5000.0],
  [D(2008, 9, 14), 'Mobile Check Deposit', 'Mobile Deposit', 2500.0, { kind: 'deposit' }],
  [D(2008, 9, 22), 'Transfer to Everyday Checking', 'Everyday Checking ••4021', -1000.0],
  [D(2008, 10, 5), 'Wire Transfer Received', 'Northern Trust', 8000.0, { kind: 'wire' }],
  [D(2008, 10, 19), 'Zelle Payment', 'Maria Lopez', -450.0, { kind: 'zelle', mode: 'send', contact: '(312) 555-0148' }],
  [D(2008, 10, 28), 'ACH Payment — Household Expenses', 'Various', -1200.0],
];

const INVEST_MOVES = [
  [D(2008, 9, 4), 'Investment Deposit', 'Brokerage Funding', 50000.0],
  [D(2008, 9, 16), 'Dividend Reinvestment', 'Portfolio', 3200.0],
  [D(2008, 9, 24), 'Wire Transfer Received', 'Fidelity Investments', 100000.0, { kind: 'wire' }],
  [D(2008, 10, 2), 'Investment Deposit', 'Brokerage Funding', 75000.0],
  [D(2008, 10, 11), 'Dividend Payment', 'Portfolio', 4150.0],
  [D(2008, 10, 20), 'Investment Deposit', 'Brokerage Funding', 60000.0],
  [D(2008, 10, 29), 'Capital Gains Distribution', 'Portfolio', 8900.0],
];

const SAVINGS_MOVES = [
  [D(2008, 9, 6), 'Interest Payment', '', 1200.0],
  [D(2008, 9, 19), 'Transfer from Everyday Checking', 'Everyday Checking ••4021', 2000.0],
  [D(2008, 10, 8), 'Interest Payment', '', 1180.0],
  [D(2008, 10, 24), 'Mobile Check Deposit', 'Mobile Deposit', 3000.0, { kind: 'deposit' }],
  ...annualCharges('Annual Dormant Account Fee', -50.0, 2009, 2025),
];

const LOAN_MOVES = [
  [D(2008, 9, 10), 'Loan Interest Charge', 'Alliance Federal Credit Union', -400.0],
  [D(2008, 10, 10), 'Loan Payment Received', '', 500.0],
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
    [JESSICA.id]: build(JESSICA, 'Opening Deposit', JESSICA_MOVES),
    [INVEST.id]: build(INVEST, 'Initial Investment Funding', INVEST_MOVES),
    [SAVINGS.id]: build(SAVINGS, 'Opening Deposit', SAVINGS_MOVES),
    [LOAN.id]: build(LOAN, 'Loan Disbursement', LOAN_MOVES),
  };
  const accounts = [CHECKING, JESSICA, INVEST, SAVINGS, LOAN].map((a) => ({ ...a, balance: built[a.id].finalBalance }));
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
    accounts.forEach((a) => console.log(`  ${a.type.padEnd(20)} (${a.number})  ${fmt(a.balance)}`));
    console.log(`  ${''.padEnd(20)}  TOTAL  ${fmt(accounts.reduce((s, a) => s + a.balance, 0))}`);
    console.log(`\nLog in at /login  ->  username: ${USERNAME}   password: ${PASSWORD}`);
  } finally {
    await client.close();
  }
}

module.exports = { buildData, TARGET, CHECKING, JESSICA, INVEST, SAVINGS, LOAN };

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}

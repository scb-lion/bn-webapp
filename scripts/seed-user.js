// Creates a demo customer + ~2 months of transactions. Run once locally:
//   node scripts/seed-user.js
// Reads MONGODB_URI, MONGODB_DB from the environment (.env.local, then .env).
//
// Idempotent: re-running upserts the user by username and REPLACES that user's
// transactions with a freshly generated set (it never touches other users).
//
// Override the login via env if you like:
//   SEED_USER_USERNAME, SEED_USER_PASSWORD
require('dotenv').config({ path: '.env.local' });
require('dotenv').config(); // fall back to .env

const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

// ---- who we're creating -----------------------------------------------------
const USERNAME = String(process.env.SEED_USER_USERNAME || 'hussyderick').toLowerCase();
const PASSWORD = String(process.env.SEED_USER_PASSWORD || 'anonymous123$');
const PROFILE = {
  firstName: 'Hussy',
  displayName: 'Hussy Derick',
  photoUrl: '',
  phone: '+1 (704) 555-0192',
  address: '284 Maple Grove Ave, Charlotte, NC 28202',
};
const EMAIL = 'hussy.derick@gmail.com';

// ---- accounts (balance is filled in from the transactions below) ------------
const CHECKING = { id: 'chk-4021', type: 'Checking', number: '4021', name: 'Everyday Checking' };
const SAVINGS = { id: 'sav-7788', type: 'Savings', number: '7788', name: 'Premier Savings' };

// ---- helpers ----------------------------------------------------------------
const cents = (d) => Math.round(d * 100);
const genRef = () => 'ref_' + Math.random().toString(36).slice(2, 14);
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(8 + (n % 10), (n * 7) % 60, 0, 0); // spread times so they aren't identical
  return d;
}

// movement rows: [daysAgo, description, counterparty, signedDollars]  (+ credit / - debit)
const CHECKING_MOVES = [
  [60, 'Opening Deposit', '', 3200.0],
  [58, 'Direct Deposit — ACME CORP PAYROLL', 'ACME Corp', 2450.0],
  [57, 'Rent Payment', 'Skyline Apartments', -1350.0],
  [56, 'Electric Bill', 'Duke Energy', -92.4],
  [55, 'Internet Service', 'Spectrum', -69.99],
  [54, 'Grocery Purchase', 'Whole Foods Market', -86.32],
  [53, 'Coffee', 'Starbucks', -6.75],
  [52, 'Fuel', 'Shell', -47.8],
  [51, 'Streaming', 'Netflix', -15.49],
  [49, 'Online Purchase', 'Amazon', -54.2],
  [48, 'Ride', 'Uber', -18.4],
  [47, 'Grocery Purchase', "Trader Joe's", -72.15],
  [46, 'Phone Bill', 'Verizon Wireless', -55.0],
  [45, 'Transfer to Savings', 'Premier Savings ••7788', -300.0],
  [44, 'Direct Deposit — ACME CORP PAYROLL', 'ACME Corp', 2450.0],
  [43, 'Streaming', 'Spotify', -10.99],
  [42, 'Gym Membership', 'Planet Fitness', -39.99],
  [41, 'Restaurant', 'Olive Garden', -63.8],
  [40, 'Grocery Purchase', 'Kroger', -94.67],
  [38, 'Fuel', 'Chevron', -44.25],
  [37, 'Coffee', 'Starbucks', -7.1],
  [35, 'Zelle Received', 'John Smith', 120.0],
  [34, 'ATM Withdrawal', 'ATM — Main St', -100.0],
  [33, 'Online Purchase', 'Amazon', -38.99],
  [31, 'Grocery Purchase', 'Whole Foods Market', -78.44],
  [30, 'Direct Deposit — ACME CORP PAYROLL', 'ACME Corp', 2450.0],
  [29, 'Rent Payment', 'Skyline Apartments', -1350.0],
  [28, 'Electric Bill', 'Duke Energy', -88.1],
  [27, 'Internet Service', 'Spectrum', -69.99],
  [26, 'Streaming', 'Netflix', -15.49],
  [25, 'Grocery Purchase', 'Aldi', -63.27],
  [24, 'Fuel', 'Shell', -49.05],
  [22, 'Restaurant', 'Chipotle', -22.35],
  [21, 'Online Purchase', 'Amazon', -73.66],
  [19, 'Coffee', 'Starbucks', -6.75],
  [18, 'Pharmacy', 'CVS', -31.2],
  [16, 'Direct Deposit — ACME CORP PAYROLL', 'ACME Corp', 2450.0],
  [15, 'Transfer to Savings', 'Premier Savings ••7788', -300.0],
  [14, 'Phone Bill', 'Verizon Wireless', -55.0],
  [13, 'Gym Membership', 'Planet Fitness', -39.99],
  [12, 'Grocery Purchase', "Trader Joe's", -81.9],
  [11, 'Streaming', 'Spotify', -10.99],
  [9, 'Fuel', 'Chevron', -46.6],
  [8, 'Restaurant', 'Panera Bread', -19.85],
  [7, 'Ride', 'Lyft', -21.3],
  [6, 'Online Purchase', 'Amazon', -42.18],
  [5, 'Grocery Purchase', 'Whole Foods Market', -90.12],
  [4, 'Coffee', 'Starbucks', -7.45],
  [3, 'Water Utility', 'City of Charlotte', -38.75],
  [2, 'Direct Deposit — ACME CORP PAYROLL', 'ACME Corp', 2450.0],
  [1, 'Grocery Purchase', 'Kroger', -58.4],
];

const SAVINGS_MOVES = [
  [60, 'Opening Deposit', '', 5000.0],
  [45, 'Transfer from Checking', 'Everyday Checking ••4021', 300.0],
  [30, 'Interest Payment', '', 4.15],
  [15, 'Transfer from Checking', 'Everyday Checking ••4021', 300.0],
  [1, 'Interest Payment', '', 4.32],
];

// Turn movement rows into transaction docs with a correct running balanceAfter.
function build(account, moves) {
  const chronological = moves.slice().sort((a, b) => b[0] - a[0]); // oldest first
  let balance = 0;
  const txns = chronological.map(([n, description, counterparty, dollars]) => {
    const amount = cents(dollars);
    balance += amount;
    return {
      accountId: account.id,
      ref: genRef(),
      date: dayOffset(n),
      description,
      counterparty,
      amount, // signed cents
      type: amount >= 0 ? 'credit' : 'debit',
      balanceAfter: balance,
    };
  });
  return { txns, finalBalance: balance };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (put it in .env.local)');
  const dbName = process.env.MONGODB_DB || 'alliance';

  const checking = build(CHECKING, CHECKING_MOVES);
  const savings = build(SAVINGS, SAVINGS_MOVES);

  const client = await MongoClient.connect(uri);
  try {
    const db = client.db(dbName);
    const users = db.collection('users');
    const transactions = db.collection('transactions');
    await users.createIndex({ username: 1 }, { unique: true });
    await transactions.createIndex({ userId: 1, date: -1 });

    const accounts = [
      { ...CHECKING, balance: checking.finalBalance },
      { ...SAVINGS, balance: savings.finalBalance },
    ];
    const now = new Date();
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    // Upsert the user by username (create, or refresh profile/accounts if present).
    const existing = await users.findOne({ username: USERNAME });
    let userId;
    if (existing) {
      userId = existing._id;
      await users.updateOne(
        { _id: userId },
        { $set: { email: EMAIL, role: 'user', active: true, profile: PROFILE, accounts, passwordHash, updatedAt: now } }
      );
      console.log(`Updated existing user "${USERNAME}" (id ${userId}).`);
    } else {
      const res = await users.insertOne({
        username: USERNAME,
        email: EMAIL,
        passwordHash,
        role: 'user',
        active: true,
        profile: PROFILE,
        accounts,
        createdAt: now,
        updatedAt: now,
      });
      userId = res.insertedId;
      console.log(`Created user "${USERNAME}" (id ${userId}).`);
    }

    // Replace this user's transactions with the freshly generated set.
    const removed = await transactions.deleteMany({ userId });
    const docs = [...checking.txns, ...savings.txns].map((t) => ({ ...t, userId }));
    await transactions.insertMany(docs);

    const fmt = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    console.log(`  cleared ${removed.deletedCount} old transaction(s), inserted ${docs.length} new.`);
    console.log(`  Checking (${CHECKING.number}) balance: ${fmt(checking.finalBalance)}  (${checking.txns.length} txns)`);
    console.log(`  Savings  (${SAVINGS.number}) balance: ${fmt(savings.finalBalance)}  (${savings.txns.length} txns)`);
    console.log(`\nLog in at /login  ->  username: ${USERNAME}   password: ${PASSWORD}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

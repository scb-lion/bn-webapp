// Caller's transactions + transfer creation (one function to stay within the
// hosting plan's serverless-function limit).
//   GET  /api/transactions            -> all of the caller's transactions
//   GET  /api/transactions?accountId= -> filtered to one account
//   GET  /api/transactions?id=        -> a single transaction (must belong to caller)
//   POST /api/transactions            -> create a transfer request (pending admin approval)
//
// Money is integer cents. A POST creates one or more PENDING transaction legs but
// does NOT change any account balance — balances only move when an admin approves
// the transfer (see api/admin/transactions.js?resource=transfer). Kinds:
//   internal -> between the caller's own accounts (debit + credit legs)
//   domestic -> to another U.S. bank (single debit leg)
//   wire     -> international wire/ACH        (single debit leg)
//   zelle    -> Zelle send/request            (send: debit leg; request: incoming credit)
//   deposit  -> mobile check deposit          (single credit leg, incoming)
const { ObjectId } = require('mongodb');
const { collections } = require('./_lib/db');
const { requireAuth, json, readBody } = require('./_lib/auth');
const { publicTxn } = require('./_lib/shape');
const { toCents, genRef, genTransferId } = require('./_lib/util');
const { sendEventEmail } = require('./_lib/email');

const KINDS = ['internal', 'domestic', 'wire', 'zelle', 'deposit'];
const s = (v) => String(v == null ? '' : v).trim().slice(0, 200);

// Whitelisted beneficiary fields kept as `meta` per kind (for admin review + detail).
const META_FIELDS = {
  internal: [],
  domestic: ['accountname', 'bankname', 'accountnum', 'accounttype'],
  wire: ['r_fname', 'r_lname', 'r_address', 'r_city', 'r_country', 'r_postal',
    'swift_code', 'iban_code', 'r_bankname', 'r_accountnum', 'r_accounttype'],
  zelle: ['contact', 'mode'],
  deposit: [],
};

function pickMeta(kind, body) {
  const meta = {};
  (META_FIELDS[kind] || []).forEach((k) => { const v = s(body[k]); if (v) meta[k] = v; });
  return meta;
}

// A human counterparty label for the transaction row.
function counterpartyFor(kind, meta) {
  if (kind === 'domestic') return meta.accountname || meta.bankname || 'External account';
  if (kind === 'wire') return [meta.r_fname, meta.r_lname].filter(Boolean).join(' ') || meta.r_bankname || 'Wire recipient';
  if (kind === 'zelle') return meta.contact || 'Zelle recipient';
  if (kind === 'deposit') return 'Mobile Check Deposit';
  return '';
}

module.exports = async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') return listTransactions(req, res, user);
  if (req.method === 'POST') return createTransfer(req, res, user);
  return json(res, 405, { error: 'Method not allowed' });
};

async function listTransactions(req, res, user) {
  const { transactions } = await collections();
  const { id, accountId } = req.query || {};

  if (id) {
    let _id;
    try { _id = new ObjectId(String(id)); } catch { return json(res, 400, { error: 'Bad id' }); }
    const txn = await transactions.findOne({ _id, userId: user._id });
    if (!txn) return json(res, 404, { error: 'Not found' });
    return json(res, 200, { transaction: publicTxn(txn) });
  }

  const query = { userId: user._id };
  if (accountId) query.accountId = String(accountId);
  const list = await transactions.find(query).sort({ date: -1 }).limit(200).toArray();
  return json(res, 200, { transactions: list.map(publicTxn) });
}

async function createTransfer(req, res, user) {
  const body = await readBody(req);
  const kind = s(body.kind).toLowerCase();
  if (!KINDS.includes(kind)) return json(res, 400, { error: 'Unknown transfer kind' });

  const amount = Math.abs(toCents(body.amount));
  if (!amount || amount <= 0) return json(res, 400, { error: 'Enter a valid amount greater than $0.00' });

  const accounts = user.accounts || [];
  const findAcct = (id) => accounts.find((a) => String(a.id) === String(id));

  // Resolve the account this transfer touches on our side.
  const fromId = s(body.fromAccountId || body.account_id);
  const fromAcct = findAcct(fromId);
  if (!fromAcct) return json(res, 400, { error: 'Choose a valid account' });

  const meta = pickMeta(kind, body);
  const description = s(body.description || body.desc);
  const { transactions } = await collections();
  const transferId = genTransferId();
  const now = new Date();

  const leg = (accountId, signedAmount, desc, counterparty) => ({
    userId: user._id,
    accountId: String(accountId),
    ref: genRef(),
    date: now,
    description: desc,
    counterparty,
    amount: signedAmount,
    type: signedAmount >= 0 ? 'credit' : 'debit',
    balanceAfter: null,
    status: 'pending',
    kind,
    transferId,
    meta,
  });

  let docs;

  if (kind === 'deposit') {
    // Incoming credit to the chosen account.
    docs = [leg(fromAcct.id, amount, description || 'Mobile Check Deposit', 'Mobile Check Deposit')];
  } else if (kind === 'zelle' && s(body.mode).toLowerCase() === 'request') {
    // Zelle request -> incoming credit once approved (no balance check).
    meta.mode = 'request';
    docs = [leg(fromAcct.id, amount, description || 'Zelle Request', counterpartyFor(kind, meta))];
  } else if (kind === 'internal') {
    const toId = s(body.toAccountId || body.to_account_id);
    const toAcct = findAcct(toId);
    if (!toAcct) return json(res, 400, { error: 'Choose a destination account' });
    if (String(toAcct.id) === String(fromAcct.id)) return json(res, 400, { error: 'Choose two different accounts' });
    if (amount > (Number(fromAcct.balance) || 0)) return json(res, 400, { error: 'Amount exceeds available balance' });
    docs = [
      leg(fromAcct.id, -amount, description || ('Transfer to ' + (toAcct.name || toAcct.type)), toAcct.name || toAcct.type),
      leg(toAcct.id, amount, description || ('Transfer from ' + (fromAcct.name || fromAcct.type)), fromAcct.name || fromAcct.type),
    ];
  } else {
    // domestic / wire / zelle send -> outgoing debit
    if (amount > (Number(fromAcct.balance) || 0)) return json(res, 400, { error: 'Amount exceeds available balance' });
    if (kind === 'zelle') meta.mode = 'send';
    const labels = { domestic: 'Domestic Transfer', wire: 'Wire/ACH Transfer', zelle: 'Zelle Payment' };
    docs = [leg(fromAcct.id, -amount, description || labels[kind], counterpartyFor(kind, meta))];
  }

  const result = await transactions.insertMany(docs);
  docs.forEach((d, i) => { d._id = result.insertedIds[i]; });

  // Notify the customer their request is pending (best-effort, never fatal).
  const primaryLeg = docs.find((d) => d.amount < 0) || docs[0];
  await sendEventEmail(user, 'transferSubmitted', {
    kind, meta, amountCents: amount,
    direction: primaryLeg.amount > 0 ? 'in' : 'out',
    counterparty: primaryLeg.counterparty || counterpartyFor(kind, meta),
    transferId,
  });

  return json(res, 201, {
    ok: true,
    status: 'pending',
    transferId,
    transactions: docs.map(publicTxn),
  });
}

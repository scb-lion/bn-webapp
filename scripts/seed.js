// Creates the first admin user. Run once locally:
//   node scripts/seed.js
// Reads MONGODB_URI, MONGODB_DB, SEED_ADMIN_* from the environment (.env.local).
require('dotenv').config({ path: '.env.local' });
require('dotenv').config(); // fall back to .env

const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (put it in .env.local)');
  const dbName = process.env.MONGODB_DB || 'alliance';
  const username = String(process.env.SEED_ADMIN_USERNAME || 'admin').toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!');
  const name = String(process.env.SEED_ADMIN_NAME || 'Bank Admin');

  const client = await MongoClient.connect(uri);
  try {
    const users = client.db(dbName).collection('users');
    await users.createIndex({ username: 1 }, { unique: true });

    const existing = await users.findOne({ username });
    if (existing) {
      console.log(`Admin "${username}" already exists (id ${existing._id}). Nothing to do.`);
      return;
    }
    const now = new Date();
    const doc = {
      username,
      email: '',
      passwordHash: await bcrypt.hash(password, 10),
      role: 'admin',
      active: true,
      profile: { firstName: name, displayName: name, photoUrl: '/assets/img/dp/Angeline1782480359.jpeg', phone: '', address: '' },
      accounts: [],
      createdAt: now,
      updatedAt: now,
    };
    const res = await users.insertOne(doc);
    console.log(`Created admin "${username}" (id ${res.insertedId}).`);
    console.log('Log in at /login with that username and the SEED_ADMIN_PASSWORD you set.');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

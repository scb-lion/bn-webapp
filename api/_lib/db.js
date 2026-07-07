// Cached MongoDB connection. In Vercel's serverless model the module scope is
// reused across warm invocations, so we memoize the client promise to avoid
// opening a new connection on every request.
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'alliance';

if (!uri) {
  // Thrown lazily on first use so the module can still be imported in tooling.
  console.warn('[db] MONGODB_URI is not set');
}

let cached = global.__mongo;
if (!cached) {
  cached = global.__mongo = { client: null, promise: null };
}

async function getDb() {
  if (!uri) throw new Error('MONGODB_URI is not configured');
  if (!cached.promise) {
    cached.promise = MongoClient.connect(uri, {
      maxPoolSize: 10,
    }).then((client) => {
      cached.client = client;
      return client;
    });
  }
  const client = await cached.promise;
  return client.db(dbName);
}

async function collections() {
  const db = await getDb();
  return {
    db,
    users: db.collection('users'),
    transactions: db.collection('transactions'),
    settings: db.collection('settings'),
    authChallenges: db.collection('authChallenges'),
  };
}

module.exports = { getDb, collections };

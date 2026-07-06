/* Local dev/verification harness — NOT deployed.
   Serves the static frontend and routes /api/* to the real serverless handlers,
   using Vercel-like (req,res) shims. If MONGODB_URI is unset, it boots an
   in-memory MongoDB so you can try the whole app with zero external setup.
   Run: node scripts/dev-server.js  ->  http://localhost:3000  */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// ---- API route table: url path -> handler module (required lazily, after env is set)
const API_ROUTES = {
  '/api/auth/login': 'api/auth/login.js',
  '/api/auth/logout': 'api/auth/logout.js',
  '/api/me': 'api/me.js',
  '/api/transactions': 'api/transactions.js',
  '/api/admin/users': 'api/admin/users.js',
  '/api/admin/user': 'api/admin/user.js',
  '/api/admin/transactions': 'api/admin/transactions.js',
};

// ---- static path resolution (mimics vercel cleanUrls + our two rewrites)
function resolveStatic(pathname) {
  // rewrites
  let m;
  if ((m = pathname.match(/^\/user\/account\/checking\/([^/]+)$/))) {
    return { file: 'user/account.html', query: { num: m[1] } };
  }
  if ((m = pathname.match(/^\/user\/transaction\/detail\/([^/]+)\/([^/]+)$/))) {
    return { file: 'user/transaction/detail.html', query: { id: m[1] } };
  }
  if (pathname === '/' || pathname === '') return { file: 'index.html', query: {} };

  const rel = pathname.replace(/^\/+/, '');
  const candidates = [rel, rel + '.html', path.join(rel, 'index.html')];
  for (const c of candidates) {
    const abs = path.join(ROOT, c);
    if (abs.startsWith(ROOT) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return { file: c, query: {} };
    }
  }
  return null;
}

function makeResShim(res) {
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (obj) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

async function handleApi(handlerFile, req, res, query) {
  const mod = require(path.join(ROOT, handlerFile));
  const handler = typeof mod === 'function' ? mod : mod.default;
  req.query = query;
  makeResShim(res);
  try {
    await handler(req, res);
  } catch (e) {
    console.error('[api error]', handlerFile, e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Server error' })); }
  }
}

function serveStatic(res, file, extraNotFound) {
  const abs = path.join(ROOT, file);
  fs.readFile(abs, (err, buf) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    res.end(buf);
  });
}

async function seedAdmin() {
  const bcrypt = require('bcryptjs');
  const { collections } = require(path.join(ROOT, 'api/_lib/db.js'));
  const { users } = await collections();
  await users.createIndex({ username: 1 }, { unique: true });
  const username = (process.env.SEED_ADMIN_USERNAME || 'admin').toLowerCase();
  const existing = await users.findOne({ username });
  if (!existing) {
    const now = new Date();
    await users.insertOne({
      username, email: '', passwordHash: await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'admin123', 10),
      role: 'admin', active: true,
      profile: { firstName: process.env.SEED_ADMIN_NAME || 'Bank Admin', displayName: process.env.SEED_ADMIN_NAME || 'Bank Admin', photoUrl: '/assets/img/dp/Angeline1782480359.jpeg', phone: '', address: '' },
      accounts: [], createdAt: now, updatedAt: now,
    });
    console.log(`  seeded admin  ->  username: ${username}  password: ${process.env.SEED_ADMIN_PASSWORD || 'admin123'}`);
  } else {
    console.log(`  admin "${username}" already present`);
  }
}

async function main() {
  let memory;
  if (!process.env.MONGODB_URI) {
    console.log('MONGODB_URI not set — starting in-memory MongoDB…');
    const { MongoMemoryServer } = require('mongodb-memory-server');
    memory = await MongoMemoryServer.create();
    process.env.MONGODB_URI = memory.getUri();
    process.env.MONGODB_DB = process.env.MONGODB_DB || 'alliance';
    console.log('  in-memory MongoDB ready');
  }
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'dev-secret-not-for-production';

  await seedAdmin();

  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname);

    if (pathname.startsWith('/api/')) {
      const routeKey = pathname.replace(/\/$/, '');
      const handlerFile = API_ROUTES[routeKey];
      if (!handlerFile) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'No such API route' })); return; }
      handleApi(handlerFile, req, res, parsed.query || {});
      return;
    }

    const resolved = resolveStatic(pathname);
    if (!resolved) { res.statusCode = 404; res.end('Not found'); return; }
    serveStatic(res, resolved.file);
  });

  server.listen(PORT, () => {
    console.log(`\nAlliance Federal Credit Union dev server:  http://localhost:${PORT}/login\n`);
  });

  process.on('SIGINT', async () => { if (memory) await memory.stop(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });

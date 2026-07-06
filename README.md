# Alliance Federal Credit Union — demo banking app

A **fictional** online-banking UI with real authentication and an admin dashboard,
built to deploy on **Vercel** with a **MongoDB** backend.

> ⚠️ Alliance Federal Credit Union is a fictional demo application for learning/portfolio use.
> It is **not a real bank** and is **not affiliated with any financial institution**.
> Do not use it to represent a real bank or to hold real money or personal data.

## What it does
- **Login** with a username + password (session stored in an httpOnly JWT cookie).
- **Admin dashboard** (`/admin`) — admins can **create users**, edit their profile,
  reset passwords, enable/disable accounts, set **account balances**, and add/edit/delete
  **transactions**. Only admins can reach it.
- **User area** (`/user/*`) — each signed-in user sees **their own** name, balances,
  and transaction history, pulled live from the database.

## Tech
- Static frontend (the existing HTML/CSS) served by Vercel.
- **Vercel Serverless Functions** in `api/` (Node.js).
- **MongoDB** (Atlas free tier works) for users + transactions.
- Auth: `bcryptjs` password hashing + `jsonwebtoken` session cookie.

## Project layout
```
api/            serverless functions (auth, me, transactions, admin/*)
  _lib/         db connection, auth guards, shaping helpers
user/           the signed-in user pages (dashboard, accounts, transactions, ...)
admin/          admin dashboard
assets/         css + images (self-contained; no external bank CDN)
js/             guard.js (auth redirect), app.js (user pages), admin.js (admin)
  scripts/       local seed/dev helpers
```

## Setup

### 1. Install
```bash
npm install
```

### 2. MongoDB
Create a free cluster at <https://www.mongodb.com/cloud/atlas> → **Connect → Drivers**
and copy the connection string.

Copy `.env.example` to `.env.local` and fill in:
```
MONGODB_URI="mongodb+srv://…"
MONGODB_DB="alliance"
JWT_SECRET="<long random string>"
SEED_ADMIN_USERNAME="admin"
SEED_ADMIN_PASSWORD="<choose a strong password>"
SEED_ADMIN_NAME="Bank Admin"
```

### 3. Create the first admin
```bash
npm run seed
```

### 4. Run locally
```bash
npm run dev        # vercel dev  (needs the Vercel CLI: npm i -g vercel)
```
or use the no-Vercel harness (spins up an in-memory MongoDB automatically):
```bash
node scripts/dev-server.js      # serves http://localhost:3000
```

Open <http://localhost:3000/login>, sign in as the admin, create a user, then log in
as that user to see their dashboard.

## Deploy to Vercel
1. Push this folder to a Git repo and **Import** it in Vercel (framework preset: **Other**,
   no build command).
2. In **Project → Settings → Environment Variables**, add `MONGODB_URI`, `MONGODB_DB`,
   and `JWT_SECRET`.
3. Deploy. Run `npm run seed` once (locally, pointing at the same `MONGODB_URI`) to create
   the admin, then log in at `/login`.

## Notes
- Money is stored as integer **cents** in the database and formatted in the browser.
- Peripheral pages (transfer, deposit, zelle, wire, support) are UI-only in this version;
  they don't move money yet. Balances/transactions are managed by the admin.

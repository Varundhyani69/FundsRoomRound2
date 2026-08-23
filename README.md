# Mini Operations ERP

A small operations ERP covering the flow **Inventory → Work Order → Stock Check → Internal Transfer / Shortage → Customer Reservation**.

The original case study brief asked for a relational database. This project uses MongoDB instead: shared entities are referenced by `ObjectId` rather than duplicated/embedded, referential integrity is enforced by the application, and every multi-step stock movement runs inside a MongoDB multi-document transaction. See [`docs/mongodb-deviation.md`](docs/mongodb-deviation.md) for the full rationale and accepted trade-offs.

## Tech stack

- **Backend:** Node.js, Express, Mongoose, MongoDB — `bcryptjs` for password hashing, `jsonwebtoken` for auth tokens, `zod` for validation, `cors`, `dotenv`
- **Frontend:** Vite + React (React Router)
- **Language:** plain JavaScript everywhere, no TypeScript
- **Backend tests:** Jest + Supertest + `mongodb-memory-server` (single-node in-memory replica set) + fast-check for property-based tests
- **Frontend tests:** Vitest + React Testing Library + fast-check for property-based tests

Layout: `backend/` (Express API) and `frontend/` (React SPA), both at the repository root.

## Minimum versions

- **Node.js:** 18 or later (declared in `engines.node` of both `backend/package.json` and `frontend/package.json`)
- **MongoDB:** 4.0 or later, **running as a replica set** — multi-document transactions are not available on a standalone `mongod` (see [Replica set requirement](#replica-set-requirement-and-transaction-retries) below)

## 1. Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/Varundhyani69/FundsRoomRound2.git
   cd FundsRoomRound2
   ```
2. Install backend dependencies:
   ```bash
   cd backend
   npm install
   ```
3. Install frontend dependencies:
   ```bash
   cd ../frontend
   npm install
   ```

## 2. Database setup

The API server and the test suite both require a MongoDB deployment that reports a replica-set name, because inventory writes and their ledger rows are committed inside a transaction (Req 8.6). Either of the following is a valid `MONGODB_URI` target:

### Option A — local replica set

1. Start `mongod` with a replica set name (in its own terminal, left running):
   ```bash
   mongod --replSet rs0 --dbpath /path/to/your/data/dir
   ```
2. In a second terminal, initiate the replica set once:
   ```bash
   mongosh --eval "rs.initiate()"
   ```
3. Point `MONGODB_URI` at it, naming the same replica set:
   ```
   MONGODB_URI=mongodb://127.0.0.1:27017/mini_operations_erp?replicaSet=rs0
   ```

### Option B — MongoDB Atlas

An Atlas cluster is already deployed as a replica set, so no `rs.initiate()` step is needed. Create a free-tier cluster, create a database user, allow your IP, and use the connection string Atlas gives you (it already contains `mongodb+srv://...`) as `MONGODB_URI`.

The backend test suite does **not** need either of the above: it starts its own throwaway in-memory replica set via `mongodb-memory-server` for the duration of `npm test`.

## 3. Environment variables

Copy each example file and fill in real values. No value in either example file is a working credential.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

### `backend/.env` (from `backend/.env.example`)

| Variable | Purpose | Required | Permitted range / format | Example (non-credential) |
|---|---|---|---|---|
| `MONGODB_URI` | MongoDB connection string; must point at a replica set or Atlas cluster | Yes | Valid MongoDB connection string | `mongodb://127.0.0.1:27017/mini_operations_erp?replicaSet=rs0` |
| `JWT_SECRET` | Secret used to sign and verify JSON Web Tokens | Yes | String, at least 32 characters | `replace-with-a-random-string-of-32-plus-chars` |
| `PORT` | Port the API server binds | Yes | Decimal integer, 1–65535 | `4000` |
| `CORS_ORIGIN` | The single browser origin allowed by CORS | Yes | Absolute origin URL | `http://localhost:5173` |
| `SEED_ADMIN_PASSWORD` | Password for the seeded Admin user (used by `npm run seed` only, not by the API server) | Only for seeding | Non-blank string, at most 72 characters | `change-me-admin` |
| `SEED_OPS_PASSWORD` | Password for the seeded OperationsUser | Only for seeding | Non-blank string, at most 72 characters | `change-me-operations` |
| `SEED_SALES_PASSWORD` | Password for the seeded SalesUser | Only for seeding | Non-blank string, at most 72 characters | `change-me-sales` |

The API server's config loader (`backend/src/config/index.js`) reads exactly four required variables — `MONGODB_URI`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN` — and exits with a message naming every missing one if any is absent, blank, or out of range. The three `SEED_*` passwords are read only by the seed script, not by the server.

### `frontend/.env` (from `frontend/.env.example`)

| Variable | Purpose | Required | Permitted range / format | Example (non-credential) |
|---|---|---|---|---|
| `VITE_API_BASE_URL` | Base URL of the API server the web client is built against | Yes | Absolute URL, no trailing slash | `http://localhost:4000` |

This is a build-time variable with no hard-coded fallback: the frontend build fails if it is absent, empty, or whitespace-only.

## 4. Running the project

Run these from the directory named in each command.

Run the API server (in `backend/`):
```bash
npm start
```
or, for auto-restart on file changes during development:
```bash
npm run dev
```

Run the web client (in `frontend/`):
```bash
npm run dev
```

Run the seed script (in `backend/`, requires `MONGODB_URI` and the three `SEED_*` passwords to be set):
```bash
npm run seed
```

Run the backend test suite (in `backend/`):
```bash
npm test
```

Run the frontend test suite (in `frontend/`):
```bash
npm test
```

## 5. Seeded users

Running `npm run seed` in `backend/` creates one user per role. Each user's password comes from an environment variable — it is never stored in a tracked file — so use the value you set for that variable in `backend/.env`:

| Email | Role | Password comes from |
|---|---|---|
| `admin@mini-erp.local` | Admin | `SEED_ADMIN_PASSWORD` |
| `operations@mini-erp.local` | OperationsUser | `SEED_OPS_PASSWORD` |
| `sales@mini-erp.local` | SalesUser | `SEED_SALES_PASSWORD` |

The seed run also creates two Locations, one Category, two Items, an Inventory Record with available stock at a location usable as an Internal Transfer source, and a Work Order whose required quantity exceeds availability, so a non-zero shortage is visible immediately.

## Replica set requirement and transaction retries

The database runs as a replica set because MongoDB multi-document transactions are only available on a replica-set (or sharded-cluster) deployment, not on a standalone `mongod`. Every operation that writes to more than one document — Internal Transfer dispatch/receipt, Customer Order reservation, and any Inventory Record change that also writes an Inventory Transaction ledger row — runs inside one such transaction.

If MongoDB labels a transaction failure as transient (`TransientTransactionError` or `UnknownTransactionCommitResult`), the API server re-executes that transaction from its first read, up to **3 retries** (4 executions in total). If the fourth execution also fails, the API responds with HTTP 409 and the error code `CONCURRENT_MODIFICATION`. See `backend/src/db/withTransaction.js` for the implementation.

## Further documentation

- [`docs/database-schema.md`](docs/database-schema.md) — every collection, its fields, types, references, and unique indexes, with an entity-relationship diagram
- [`docs/er-diagram.mmd`](docs/er-diagram.mmd) — the tracked Mermaid source of that diagram
- [`docs/api.md`](docs/api.md) — every route with its method, path, permitted roles, request/response schemas, error codes, and examples
- [`docs/mongodb-deviation.md`](docs/mongodb-deviation.md) — why MongoDB replaces the relational database of the original brief, and the accepted trade-offs
- [`docs/extensibility.md`](docs/extensibility.md) — where to make specific future changes (damaged quantity, partial transfer receipt, order cancellation, location-restricted users)

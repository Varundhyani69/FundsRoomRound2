# Mini Operations ERP

A small operations ERP covering the flow **Inventory → Work Order → Stock Check → Internal Transfer / Shortage → Customer Reservation**.

The data lives in MySQL 8 with a fully normalised relational schema: ten tables, twenty foreign keys, and the business invariants declared as `CHECK` constraints and `UNIQUE` indexes so the database refuses illegal data even if application code were bypassed. Every multi-step stock movement runs inside one InnoDB transaction. Queries are hand-written SQL through `mysql2` rather than an ORM, so what runs against the database is exactly what is in the source. See [`docs/database-schema.md`](docs/database-schema.md) for the schema and [`docs/data-integrity.md`](docs/data-integrity.md) for how the invariants and the concurrency guarantees are enforced.

## Live demo

A review instance is running at **http://34.239.240.245:5173**.

Sign in with any of the three seeded roles — `admin@mini-erp.local` (Admin), `operations@mini-erp.local` (OperationsUser), or `sales@mini-erp.local` (SalesUser). The login screen itself lists all three with a click-to-fill button each, so no password needs to be written down here.

It runs via Docker Compose on a single EC2 instance and is a throwaway review deployment seeded with sample data, so those credentials are deliberately public and it holds nothing real.

The public IP is not an Elastic IP, so it changes if the instance is restarted.

## Tech stack

- **Backend:** Node.js, Express, MySQL 8 (via `mysql2`, hand-written SQL — no ORM) — `bcryptjs` for password hashing, `jsonwebtoken` for auth tokens, `zod` for validation, `cors`, `dotenv`. The API surface is published as an OpenAPI 3.0.3 spec with a generated Postman collection
- **Frontend:** Vite + React (React Router)
- **Language:** plain JavaScript everywhere, no TypeScript
- **Backend tests:** Jest + Supertest + fast-check for property-based tests, run against a throwaway MySQL database the suite creates and drops itself
- **Frontend tests:** Vitest + React Testing Library + fast-check for property-based tests

Layout: `backend/` (Express API) and `frontend/` (React SPA), both at the repository root.

## Minimum versions

- **Node.js:** 18 or later (declared in `engines.node` of both `backend/package.json` and `frontend/package.json`)
- **MySQL:** 8.0.16 or later. That is the floor because the schema uses `CHECK` constraints, which earlier versions parse and then silently ignore. No special deployment shape is needed — a single ordinary MySQL server is enough, since InnoDB provides transactions natively.

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

Any single MySQL 8.0.16+ server works — local install, Docker, or a managed host such as AWS RDS. No replication or cluster configuration is required, because InnoDB provides transactions on an ordinary standalone server.

1. Make sure MySQL is running and you have a user that can create a database. On a local install the default `root` user is fine.

2. Fill in the `MYSQL_*` values in `backend/.env` (see the next section). You do **not** need to create the database by hand — the migration does it.

3. Create the schema:
   ```bash
   cd backend
   npm run migrate
   ```
   This creates `MYSQL_DATABASE` if it does not exist and applies [`backend/src/db/schema.sql`](backend/src/db/schema.sql) to it. It is idempotent, so re-running it on an existing database is a no-op — safe to run after every deploy.

4. Load the starting data (see [Seeded users](#5-seeded-users)):
   ```bash
   npm run seed
   ```

### Using Docker instead of a local install

```bash
docker run --name erp-mysql -e MYSQL_ROOT_PASSWORD=your-password -p 3306:3306 -d mysql:8
```
Then set `MYSQL_HOST=127.0.0.1`, `MYSQL_PORT=3306`, `MYSQL_USER=root`, and `MYSQL_PASSWORD=your-password`.

### What the test suite uses

The backend test suite never touches the database above. It creates, uses, and then drops a separate database named `<MYSQL_DATABASE>_test` for the duration of `npm test`, applying the same `schema.sql` through the same migration code a deployment uses. The `MYSQL_USER` in your `.env` therefore needs `CREATE`/`DROP DATABASE` rights to run the tests.

## 3. Environment variables

Copy each example file and fill in real values. No value in either example file is a working credential.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

### `backend/.env` (from `backend/.env.example`)

| Variable | Purpose | Required | Permitted range / format | Example (non-credential) |
|---|---|---|---|---|
| `MYSQL_HOST` | Hostname or endpoint of the MySQL server | Yes | Hostname or IP | `127.0.0.1` |
| `MYSQL_PORT` | Port of the MySQL server | Yes | Decimal integer, 1–65535 | `3306` |
| `MYSQL_USER` | MySQL user the API server connects as | Yes | Non-blank string | `erp_app` |
| `MYSQL_PASSWORD` | Password for that user | Must be present; may be empty | Any string, including empty | `replace-with-that-user-password` |
| `MYSQL_DATABASE` | Database holding the application's tables | Yes | Valid MySQL identifier | `mini_operations_erp` |
| `JWT_SECRET` | Secret used to sign and verify JSON Web Tokens | Yes | String, at least 32 characters | `replace-with-a-random-string-of-32-plus-chars` |
| `PORT` | Port the API server binds | Yes | Decimal integer, 1–65535 | `4000` |
| `CORS_ORIGIN` | The single browser origin allowed by CORS | Yes | Absolute origin URL | `http://localhost:5173` |
| `SEED_ADMIN_PASSWORD` | Password for the seeded Admin user (used by `npm run seed` only, not by the API server) | Only for seeding | Non-blank string, at most 72 characters | `change-me-admin` |
| `SEED_OPS_PASSWORD` | Password for the seeded OperationsUser | Only for seeding | Non-blank string, at most 72 characters | `change-me-operations` |
| `SEED_SALES_PASSWORD` | Password for the seeded SalesUser | Only for seeding | Non-blank string, at most 72 characters | `change-me-sales` |

The API server's config loader (`backend/src/config/index.js`) reads exactly eight required variables — the five `MYSQL_*` values, `JWT_SECRET`, `PORT`, and `CORS_ORIGIN` — and exits with a message naming every missing one if any is absent, blank, or out of range. `MYSQL_PASSWORD` is the one exception to "blank is missing": it must be present but may be empty, because a local MySQL user legitimately can have no password. The three `SEED_*` passwords are read only by the seed script, not by the server.

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

Run the seed script (in `backend/`, requires the `MYSQL_*` values and the three `SEED_*` passwords to be set):
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

## 5. Postman collection and OpenAPI spec

Import these two tracked files into Postman (**Import → Files**):

- [`postman/mini-operations-erp.postman_collection.json`](postman/mini-operations-erp.postman_collection.json) — every route, grouped in folders, with a pre-filled JSON body where one is needed and the permitted roles in each request's description
- [`postman/mini-operations-erp.postman_environment.json`](postman/mini-operations-erp.postman_environment.json) — `baseUrl` and `token`, so the same collection can be retargeted by switching environment rather than editing requests. It ships pointing at `http://localhost:4000`; set `baseUrl` to `http://34.239.240.245:4000` to run the collection against the [live demo](#live-demo) instead

Send the login request first. Its test script reads the JWT out of the response and stores it in the `token` collection variable, and every other request already sends `Authorization: Bearer {{token}}` — so after one login the whole collection is authenticated with no copy-paste.

With the API server running, **`http://localhost:4000/docs.json`** still serves the raw OpenAPI 3.0.3 specification. That URL can be imported straight into Postman or Insomnia as an alternative to the collection above.

The collection is regenerated with `npm run postman` in `backend/` and is derived from `backend/src/openapi.js`, which `backend/tests/docs.test.js` asserts against the real Express router — so a route the collection is missing, or one it invents, fails the test suite.

That spec is in turn built from the same sources the server uses at runtime: permitted roles come from `permissions.js` and error codes from `errorCodes.js`, so they cannot drift from the behaviour they describe.

[`docs/api.md`](docs/api.md) covers the same surface in prose, with request and response examples.

## 6. Seeded users

Running `npm run seed` in `backend/` creates one user per role. Each user's password comes from an environment variable — it is never stored in a tracked file — so use the value you set for that variable in `backend/.env`:

| Email | Role | Password comes from |
|---|---|---|
| `admin@mini-erp.local` | Admin | `SEED_ADMIN_PASSWORD` |
| `operations@mini-erp.local` | OperationsUser | `SEED_OPS_PASSWORD` |
| `sales@mini-erp.local` | SalesUser | `SEED_SALES_PASSWORD` |

The seed run also creates two Locations, one Category, two Items, an Inventory Record with available stock at a location usable as an Internal Transfer source, and a Work Order whose required quantity exceeds availability, so a non-zero shortage is visible immediately.

## Transactions and transaction retries

Every operation that writes more than one row runs inside a single InnoDB transaction: Internal Transfer dispatch and receipt, Customer Order reservation, and any Inventory Record change (each one also writes its Inventory Transaction ledger row). `backend/src/db/withTransaction.js` is the only place that opens one, and it takes a dedicated pooled connection for the transaction's duration — in MySQL, `BEGIN`/`COMMIT` are connection state, so a shared connection would let two concurrent requests interleave statements inside each other's transaction.

If MySQL rolls a transaction back for a timing reason — a deadlock (`ER_LOCK_DEADLOCK`) or a lock-wait timeout (`ER_LOCK_WAIT_TIMEOUT`) — the API server re-executes it from its first read, up to **3 retries** (4 executions in total). If the fourth also fails, the API responds with HTTP 409 and the error code `CONCURRENT_MODIFICATION`. Any other error is deterministic and would fail again identically, so it is not retried.

Concurrency safety does not rely on those retries, though. Reservations take a row lock (`SELECT ... FOR UPDATE`) before reading the balances they are about to change, and the write itself carries the availability check in its `WHERE` clause, so the accept/reject decision comes from the database's own `affectedRows` rather than from a value read earlier. Two users cannot both reserve the same stock. See [`docs/data-integrity.md`](docs/data-integrity.md).

## Further documentation

- [`docs/database-schema.md`](docs/database-schema.md) — every table, its columns, types, nullability, foreign keys, unique indexes, and check constraints, with an entity-relationship diagram
- [`docs/er-diagram.mmd`](docs/er-diagram.mmd) — the tracked Mermaid source of that diagram
- [`docs/data-integrity.md`](docs/data-integrity.md) — how the invariants are held: the check constraints, the transaction wrapper and its retries, the `movement_reference` idempotency key, and the row lock plus `WHERE`-clause predicate that make concurrent reservations safe
- [`docs/api.md`](docs/api.md) — every route with its method, path, permitted roles, request/response schemas, error codes, and examples
- [`docs/extensibility.md`](docs/extensibility.md) — where to make specific future changes (damaged quantity, partial transfer receipt, order cancellation, location-restricted users)

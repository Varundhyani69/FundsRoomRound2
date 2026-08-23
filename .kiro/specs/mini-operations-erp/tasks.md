# Implementation Plan: Mini Operations ERP

## Overview

Eleven top-level tasks that follow the ten increments of the design's Incremental Delivery Plan (increment 10 is split into frontend and documentation so no commit introduces more than three capabilities, Req 14.3). Stack is Express + MySQL 8 + React in plain JavaScript, no TypeScript: `backend/` (Express with hand-written SQL through `mysql2`, Jest + Supertest against a throwaway `<MYSQL_DATABASE>_test` database + fast-check) and `frontend/` (Vite + React, Vitest + React Testing Library), both at the repository root.

Every top-level task ends with a sub-task that runs the test suite and then stages, commits, and pushes to `https://github.com/Varundhyani69/FundsRoomRound2`, so the repository history shows the increments (Req 14.1, 14.2, 14.7). Nothing is committed before task 1.1 has verified the remote.

Scope discipline: no file, function, or abstraction beyond what design.md names. Layering is routes → controllers → services → SQL plus middleware, and every quantity comparison and status transition lives in a named exported service function (Req 15.5).

## Tasks

- [x] 1. Repository setup, project skeleton, cross-cutting middleware, and test harness
  - [x] 1.1 Initialise and verify the git remote and repository hygiene
    - Run `git status` / `git remote -v`; if no repository exists run `git init`, and if no `origin` exists add `https://github.com/Varundhyani69/FundsRoomRound2`
    - Confirm the default branch name and that `git fetch origin` reaches the remote before any code is committed
    - Create `.gitignore` at the repository root excluding `node_modules/`, `.env`, `.env.*` (but not `.env.example`), `coverage/`, `dist/`
    - Create a placeholder `README.md` naming the project and stack (expanded in task 11)
    - _Requirements: 14.2, 14.4, 14.5_

  - [x] 1.2 Create the backend package and folder skeleton
    - `backend/package.json` with scripts `start`, `dev`, `test` (`jest --runInBand`), `migrate`, `seed`; dependencies `express`, `mysql2`, `bcrypt`, `jsonwebtoken`, `zod`, `cors`, `dotenv`; devDependencies `jest`, `supertest`, `fast-check` — all at pinned versions. No in-memory MySQL exists, so no such package is added: the suite runs against a real server in its own database (task 1.8)
    - Create the empty directory layout from design.md: `backend/src/{config,db,middleware,errors,services,controllers,routes,validation}`, `backend/scripts`, `backend/tests/setup`
    - `backend/.env.example` listing `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN`, `SEED_ADMIN_PASSWORD`, `SEED_OPS_PASSWORD`, `SEED_SALES_PASSWORD` with placeholder non-credential values, and a note that the test suite uses `<MYSQL_DATABASE>_test` rather than the database named here
    - _Requirements: 10.6, 10.7, 14.6_

  - [x] 1.3 Implement the config loader
    - `backend/src/config/index.js` — the only module that reads `process.env`; exactly eight required variables (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN`), with `MYSQL_PASSWORD` required to be present but allowed to be empty because a passwordless local MySQL is a legitimate setup; single stderr message naming every missing one, `process.exit(1)`, 1–65535 range check on both `MYSQL_PORT` and `PORT`, `JWT_SECRET` length ≥ 32 check, no defaults; the resolved settings are grouped as `config.mysql` so a caller hands them straight to `mysql2`'s `createPool`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.9, 10.10_

  - [x] 1.4 Implement AppError and the error code table
    - `backend/src/errors/AppError.js` (`status`, `code`, `message`, optional `details`, non-serialized `cause`)
    - `backend/src/errors/errorCodes.js` — the `code -> httpStatus` object holding every code from the design's error code table
    - _Requirements: 9.5, 13.9_

  - [x] 1.5 Implement the cross-cutting middleware
    - `backend/src/middleware/errorHandler.js` — `SyntaxError`/`MALFORMED_JSON` branch, `AppError` branch, duplicate-key safety net, `INTERNAL_ERROR` fallback with no stack trace, file path, module name, or database text
    - `backend/src/middleware/notFound.js` — `ROUTE_NOT_FOUND` 404
    - `backend/src/middleware/requestLog.js` — one line per finished response with method, path, status, and code when status ≥ 400
    - _Requirements: 9.5, 9.6, 9.7, 9.8, 9.11, 9.12_

  - [x] 1.6 Assemble the Express app and the server process
    - `backend/src/app.js` — CORS with the single configured origin, `express.json()`, `requestLog`, `/api` router mount point, `notFound`, `errorHandler` last; exports the app without listening so Supertest can drive it in-process
    - `backend/src/routes/index.js` — empty `/api` router for now, routers mounted in later increments
    - `backend/src/server.js` — config → connect → listen, plus `SIGINT`/`SIGTERM` handling that stops accepting connections and closes the MySQL pool — which ends every open connection and rolls back any transaction still in progress on them — exits 0, and forces `process.exit(1)` after a 10-second deadline
    - _Requirements: 8.4, 9.1, 12.13_

  - [x] 1.7 Implement the database connection module
    - `backend/src/db/pool.js` — the one lazily created `mysql2` promise pool (`connectionLimit: 10`, `multipleStatements: false`, positional `?` placeholders only), plus `query`, `closePool`, and `isPoolOpen`
    - `backend/src/db/id.js` — `newId()`, the 24-character lowercase hex primary key every table uses, so the id shape the API already validates is unchanged
    - `backend/src/db/schema.sql` and `backend/scripts/migrate.js` behind `npm run migrate` — the schema file each later increment appends its `CREATE TABLE` to, and the runner that creates the database if absent and applies every statement of that file; idempotent, because each statement is `CREATE TABLE IF NOT EXISTS`
    - `backend/src/db/connect.js` — opens the pool from `config.mysql`, round-trips `SELECT VERSION()` so a bad host or credential fails before the port is bound, and logs one startup line naming the server version and whether every transactional table is on InnoDB (`checkStorageEngines`), warning instead when the schema has not been migrated; `disconnect()` closes the pool
    - _Requirements: 8.1, 8.6_

  - [x] 1.8 Build the test harness against a throwaway MySQL database
    - `backend/jest.config.js` — `globalSetup`, `globalTeardown`, `setupFilesAfterEnv`, `testEnvironment: 'node'`, `maxWorkers: 1` serial execution
    - `backend/tests/setup/globalSetup.js` — drops and recreates `<MYSQL_DATABASE>_test` beside the application's own database and applies `src/db/schema.sql` to it through `scripts/migrate.js`, the same code path `npm run migrate` uses; writes the resolved `MYSQL_*`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN` values to a gitignored JSON handoff file, since assignments to `process.env` here do not reach the workers
    - `backend/tests/setup/globalTeardown.js` — drops the test database again and removes the handoff file
    - `backend/tests/setup/assertTransactional.js` — `checkStorageEngines()` check, stderr reason and non-zero exit when any table is missing or is not InnoDB, run before any test, because `BEGIN`/`COMMIT`/`ROLLBACK` are accepted and then silently ignored on other engines
    - `backend/tests/setup/dbSetup.js` — loads the handoff file into `process.env` before anything requires `src/config`, connects once, `beforeEach` deletion of every row from every table child-table-first so each foreign key stays satisfied, disconnect after all
    - `backend/tests/setup/tables.js` — one small SQL-backed read accessor per table (`find`, `findOne`, `findById`, `countDocuments`, `exists`, with `.sort()`/`.lean()` chaining) returning rows under the camelCase names the assertions read, so a test that checks stored state reads as what it is checking rather than as a query string; plus `create`/`updateOne`/`updateMany` for arranging a precondition no route can express
    - `backend/tests/setup/agent.js` — Supertest agent over the exported app
    - _Requirements: 12.8, 12.9, 12.10, 12.11_

  - [x]* 1.9 Write unit tests for the config loader
    - `backend/tests/config.test.js` — missing/blank variable subsets, port range rejection, short secret rejection, and a check that no module outside `src/config` reads `process.env`
    - _Requirements: 10.2, 10.3, 10.4, 10.9, 10.10_

  - [x]* 1.10 Write property test for the config loader
    - `backend/tests/properties/api.pbt.test.js`
    - **Property 18: The config loader accepts exactly the valid environments**
    - **Validates: Requirements 10.2, 10.9, 10.10**

  - [x]* 1.11 Write unit tests for the error surface
    - `backend/tests/errors.test.js` — `{ code, message }` envelope, `ROUTE_NOT_FOUND`, `MALFORMED_JSON`, `INTERNAL_ERROR` message hygiene, and the request log line format
    - _Requirements: 9.5, 9.6, 9.7, 9.8, 9.11, 9.12_

  - [x] 1.12 Run the suite, commit, and push increment 1
    - Run `npm test` in `backend/`; only proceed when it exits 0
    - `git add`, `git commit -m "Add project skeleton, config loader, error handling and test harness"`, `git push -u origin <default-branch>`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 2. Authentication
  - [x] 2.1 Create the users table
    - `backend/src/db/schema.sql` — `CREATE TABLE users`: `id` CHAR(24) primary key, `email` VARCHAR(254) under `uq_users_email`, `password_hash` CHAR(60), `role` ENUM(`'Admin'`, `'OperationsUser'`, `'SalesUser'`), nullable `assigned_location_id`, `created_at`/`updated_at` DATETIME(3), InnoDB and `utf8mb4_0900_as_cs`
    - `fk_users_assigned_location` ON DELETE SET NULL ON UPDATE RESTRICT, so removing a location leaves its people unassigned rather than deleted; the `locations` table it references is declared ahead of `users` in the file and lands with task 4.1
    - The service trims and lowercases `email` before binding it, so the unique index compares like with like; `password_hash` is named by no query except the login lookup, so it cannot reach a response by accident
    - _Requirements: 1.1, 1.5, 15.4_

  - [x] 2.2 Implement the auth service
    - `backend/src/services/auth.service.js` — `login(email, password)`: the one `SELECT id, email, password_hash, role, assigned_location_id FROM users WHERE email = ?` lookup, `bcrypt.compare`, identical `INVALID_CREDENTIALS` AppError for unmatched email and failed comparison, `jsonwebtoken.sign({ sub, role }, config.jwtSecret, { expiresIn: '8h' })`, and a `hashPassword` helper at cost 10 used by the seed script
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.10_

  - [x] 2.3 Implement the validation middleware and shared schemas
    - `backend/src/middleware/validate.js` — runs `params`/`query`/`body` schemas, attaches `req.validated`, maps `objectId` failures to `INVALID_IDENTIFIER` and everything else to `VALIDATION_ERROR` with one `details` entry per rejected field
    - `backend/src/validation/common.js` — `objectId`, `validQuantity`, `batch`, `customerName`
    - `backend/src/validation/auth.schemas.js` — strict login body schema (non-blank email ≤ 254, password ≤ 72)
    - _Requirements: 1.11, 9.1, 9.2, 9.3, 9.4, 9.10_

  - [x] 2.4 Implement the authenticate middleware
    - `backend/src/middleware/authenticate.js` — reads `Authorization: Bearer <token>`; absent, undecodable, badly signed, or expired all yield 401 `UNAUTHENTICATED`; on success sets `req.user = { id, role }` only
    - _Requirements: 1.7, 1.8, 1.9_

  - [x] 2.5 Wire the auth route into the API router
    - `backend/src/controllers/auth.controller.js`, `backend/src/routes/auth.routes.js` (`POST /api/auth/login`)
    - `backend/src/routes/index.js` — mount `auth.routes.js` before `authenticate`, then apply `authenticate` to every later router so no unauthenticated request reaches role evaluation
    - _Requirements: 1.8, 2.1_

  - [x] 2.6 Add the per-test seed fixture users
    - `backend/tests/setup/seedFixture.js` — one User per Role with known passwords, plus a `tokenFor(role)` helper; loaded in `beforeEach` so tests pass in any order
    - _Requirements: 12.11_

  - [x]* 2.7 Write unit tests for authentication
    - `backend/tests/auth.test.js` — login success payload excluding `passwordHash`, bcrypt hash format and cost band, JWT claims and 8-hour expiry, identical rejection shape for both failure modes, and the four token states against a protected route
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.11_

  - [x] 2.8 Run the suite, commit, and push increment 2
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add authentication with bcrypt hashing and JWT verification"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 3. Authorization
  - [x] 3.1 Create the single route-to-role permission map
    - `backend/src/permissions.js` — `ROLES` and `WRITE_ROUTE_PERMISSIONS` keyed `"<METHOD> <mounted path>"`, containing every write route of the design's API surface including `PATCH /api/work-orders/:id/status`
    - _Requirements: 2.8, 2.14_

  - [x] 3.2 Implement the authorize middleware
    - `backend/src/middleware/authorize.js` — role-enum check first, reads pass for any valid role, write routes looked up by `${req.method} ${req.baseUrl}${req.route.path}`, deny-by-default `FORBIDDEN` for unmapped write routes
    - Attach it per route (not app-wide) so `req.route.path` is populated; document that pattern in a one-line comment
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.11, 2.12, 2.13_

  - [x]* 3.3 Write unit tests for authorize and the permission map
    - `backend/tests/authorization.test.js` — role × route matrix over `authenticate` + `authorize` mounted on stub write routes in a test-only app (`backend/tests/setup/authorizeTestApp.js`), unknown-role and unmapped-route denial, and a completeness assertion that every write route the real app declares has exactly one entry in `WRITE_ROUTE_PERMISSIONS`
    - Note: mandatory test 5 needs a real restricted write route with a targeted row, so it is added to this same file in task 5.12, as soon as `POST /api/inventory` exists
    - _Requirements: 2.1, 2.3, 2.5, 2.7, 2.8, 2.11, 2.12, 2.13, 2.14_

  - [x] 3.4 Run the suite, commit, and push increment 3
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add role-based authorization with a single write-route permission map"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 4. Reference data and the seed script
  - [x] 4.1 Create the reference data tables
    - `backend/src/db/schema.sql` — `CREATE TABLE categories` (`name` under `uq_categories_name`), `CREATE TABLE locations` (`code` under `uq_locations_code`, plus `name`, which two locations may share), `CREATE TABLE items` (`code` under `uq_items_code`, `name`, `category_id` NOT NULL)
    - `items` also carries the non-unique `ix_items_category` so listing one category's items is an index range scan, and `fk_items_category` ON DELETE RESTRICT ON UPDATE RESTRICT, so deleting a referenced category is refused rather than silently taking its items with it
    - `backend/src/db/mappers.js` — `toCategory`, `toItem`, `toLocation`, `toUserRef`, which rebuild the nested response shape from the aliased columns of a JOIN row
    - _Requirements: 3.2_

  - [x] 4.2 Add the reference list routes
    - `backend/src/controllers/reference.controller.js` and `backend/src/routes/reference.routes.js` — `GET /api/items` (joining `categories` so each item carries its category), `GET /api/locations`, `GET /api/users` (id, email, role only)
    - Mount in `backend/src/routes/index.js` behind `authenticate` + `authorize`
    - _Requirements: 2.13, 3.2_

  - [x] 4.3 Write the non-interactive seed script
    - `backend/scripts/seed.js` — validates `SEED_ADMIN_PASSWORD`, `SEED_OPS_PASSWORD`, `SEED_SALES_PASSWORD` and exits non-zero when any is absent; creates one Admin, one Operations_User, one Sales_User, two Locations, one Category, and two Items; idempotent by `INSERT ... ON DUPLICATE KEY UPDATE` on each unique business key (user email, location code, category name, item code); requires no interactive input
    - Add the `seed` script entry to `backend/package.json`
    - _Requirements: 13.5, 13.8, 14.5_

  - [x] 4.4 Extend the per-test seed fixture with reference data
    - `backend/tests/setup/seedFixture.js` — add two Locations, one Category, two Items, and set `assignedLocation` on the seeded Operations_User
    - _Requirements: 12.11_

  - [x]* 4.5 Write unit tests for the reference routes
    - `backend/tests/reference.test.js` — authenticated list responses and shapes, 401 without a token
    - _Requirements: 2.13, 3.2_

  - [x] 4.6 Run the suite, commit, and push increment 4
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add category, item and location reference data with seed script"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 5. Inventory core: availability, transactions, records, and ledger
  - [x] 5.1 Create the inventory_records table and its declared quantity bounds
    - `backend/src/db/schema.sql` — `CREATE TABLE inventory_records`: `item_id`, `location_id`, `batch` VARCHAR(32), `physical_quantity` and `reserved_quantity` INT UNSIGNED so the database itself refuses a negative balance, `fk_inventory_item` and `fk_inventory_location` both ON DELETE RESTRICT, and no stored available column — availability is derived on every read
    - `CHECK` constraints carrying the bounds the application also guards: `ck_inventory_physical_max` and `ck_inventory_reserved_max` (≤ 999,999,999) and `ck_inventory_reserved_lte_physical` (`reserved_quantity <= physical_quantity`), which is what makes a non-negative available quantity true by construction; the 1..1,000,000 request-side bound stays in `validQuantity` in `backend/src/validation/common.js`
    - Declare the `(item_id, location_id, batch)` key pattern **once**, as `uq_inventory_item_location_batch`; add only `ix_inventory_location` beside it, which exists because `WHERE location_id = ?` cannot use the unique index, not as a duplicate of it
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.10_

  - [x] 5.2 Create the append-only inventory_transactions ledger table
    - `backend/src/db/schema.sql` — `CREATE TABLE inventory_transactions`: `inventory_record_id`, SIGNED `physical_delta` and `reserved_delta` so an outward movement is negative, `movement_reference` VARCHAR(200) under `uq_inventory_transactions_movement_reference`, `applied_at`, nullable `created_by`; `ix_inventory_transactions_record_applied (inventory_record_id, applied_at)` for ledger reconstruction in application order, `ix_inventory_transactions_created_by`, `fk_inventory_transactions_record` ON DELETE RESTRICT and `fk_inventory_transactions_created_by` ON DELETE SET NULL
    - Append-only is a property of the code paths rather than a column: no route, controller, or service issues an `UPDATE` or a `DELETE` against this table, and it carries no `updated_at` because nothing would ever set one
    - _Requirements: 4.4, 4.5, 4.7, 4.10_

  - [x] 5.3 Implement the availability module
    - `backend/src/services/availability.js` — `availableQuantity(record)` and `locationAvailableQuantity(records)` for the read paths, `AVAILABLE_SQL` / `AVAILABLE_SQL_FOR(alias)` for a `SELECT` to project the same rule as a derived column, and `hasAvailableAtLeastSql(quantity)` plus `hasPhysicalAtLeastSql(quantity)` returning a `WHERE`-clause fragment with its bound parameter, so a conditional `UPDATE` lets MySQL decide availability as part of the write; the only module in the codebase that subtracts `reservedQuantity` from `physicalQuantity`
    - _Requirements: 3.3, 3.4, 3.5, 3.12, 15.1_

  - [x] 5.4 Implement the transaction helper
    - `backend/src/db/withTransaction.js` — a fresh pooled connection per attempt so a retry re-runs the callback from its first read, `beginTransaction`, commit on success, `rollback` on any error with a rollback failure swallowed, `connection.release()` in `finally` on every exit path, retry only on `ER_LOCK_DEADLOCK` (1213) and `ER_LOCK_WAIT_TIMEOUT` (1205) up to 3 times (4 attempts), then `CONCURRENT_MODIFICATION` 409; every read and write of the callback runs on the connection it is handed, never on the pool
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x] 5.5 Implement the movement reference builders
    - `backend/src/services/movementReference.js` — `openingMovementReference`, `adjustMovementReference`, `transferMovementReference`, `reserveMovementReference` exactly as named in design.md
    - _Requirements: 4.5, 4.6, 4.9_

  - [x] 5.6 Implement the inventory service
    - `backend/src/services/inventory.service.js` — `applyMovement` (the one place that writes a record change and its ledger row on the caller's transaction connection: `SELECT ... FOR UPDATE` on the target row first, the guards decided against values read under that lock, the same predicates repeated in the `UPDATE ... WHERE` clause and checked through `affectedRows`, and the ledger `INSERT` whose `ER_DUP_ENTRY` — recognised by the exported `isDuplicateKey`, errno 1062 — becomes `DUPLICATE_INVENTORY_TRANSACTION`), named guards `assertSufficientPhysical` and `assertSufficientAvailable`, `createInventoryRecord` (id pre-generated by `newId()`, existence checks returning `INVALID_REFERENCE` rather than a raw foreign key failure, a triple refused by `uq_inventory_item_location_batch` returning `DUPLICATE_INVENTORY_RECORD`, opening ledger row in the same transaction), `adjustInventoryRecord` (`IN`/`OUT`), `listInventoryRecords`, `getLocationAvailability` (0 when no rows)
    - _Requirements: 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 4.2, 4.3, 4.4, 4.6, 4.9, 8.1, 15.5_

  - [x] 5.7 Add the inventory validation schemas and quantity error code selection
    - `backend/src/validation/inventory.schemas.js` — strict bodies for create (`item`, `location`, `batch`, `physicalQuantity`, `movementReference`) and adjust (`direction`, `quantity`, `movementReference`), plus the `?item&location` query schemas
    - Extend `backend/src/middleware/validate.js` so a failure whose issue paths all name a quantity field reports `INVALID_QUANTITY` and mixed failures fall back to `VALIDATION_ERROR`
    - _Requirements: 4.1, 4.8, 9.2, 9.3, 9.4_

  - [x] 5.8 Wire the inventory routes
    - `backend/src/controllers/inventory.controller.js` (reads `req.validated` and `req.user` only, no quantity comparisons) and `backend/src/routes/inventory.routes.js` — `GET /api/inventory`, `GET /api/inventory/availability`, `POST /api/inventory`, `POST /api/inventory/:id/adjust` with `authorize` and `validate` attached per route
    - Mount in `backend/src/routes/index.js`
    - _Requirements: 2.4, 2.5, 3.3, 3.5, 9.1, 15.5_

  - [x] 5.9 Extend the seed script and the test fixture with inventory records
    - `backend/scripts/seed.js` — add at least one Inventory_Record whose Available_Quantity is ≥ 1 at a location usable as a transfer source
    - `backend/tests/setup/seedFixture.js` — add two Inventory_Records with stated physical and reserved quantities
    - _Requirements: 12.11, 13.5_

  - [x]* 5.10 Add the shared property test generators
    - `backend/tests/setup/generators.js` — `genQuantity`, `genInvalidQuantity`, `genBatch`, `genRecordLayout`, `genOperationSequence`, `genUnusedObjectId`, `genMalformedId`, `genRole`, `genConcurrentQuantities`; fast-check configured with `numRuns: 25` minimum and counterexample seed reporting
    - _Requirements: 12.7_

  - [x]* 5.11 Write unit tests for inventory creation, adjustment, and reads
    - `backend/tests/inventory.test.js` — 100/30 → 70 example, duplicate triple 409, `INVALID_REFERENCE`, opening ledger row contents, adjustment guards, availability read of 0 when no record exists
    - `backend/tests/schema.test.js` — asserts each database-level constraint directly, with SQL that bypasses every service: `ck_inventory_reserved_lte_physical`, the `INT UNSIGNED` floor, `uq_inventory_item_location_batch` (including `'a'` and `'A'` staying distinct under the case-sensitive collation), the movement-reference unique index, and a record referencing an absent item
    - _Requirements: 3.4, 3.7, 3.11, 3.12, 4.2, 4.3, 4.9_

  - [x] 5.12 Write mandatory test 5 against a real restricted write route
    - Extend `backend/tests/authorization.test.js` — a Sales_User token calling `POST /api/inventory/:id/adjust` receives 403 `FORBIDDEN`, and every field of the targeted Inventory_Record equals the value read immediately before the request; issued over HTTP through the app
    - _Requirements: 2.5, 12.5, 12.13_

  - [x]* 5.13 Write property test for derived availability
    - `backend/tests/properties/inventory.pbt.test.js`
    - **Property 1: Available quantity is always the derived difference**
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.12, 15.1**

  - [x]* 5.14 Write property test for the inventory invariants
    - **Property 2: Inventory invariants survive every accepted operation**
    - **Validates: Requirements 3.8, 3.9**

  - [x]* 5.15 Write property test for record identity
    - **Property 3: Item, location, and batch identify at most one record**
    - **Validates: Requirements 3.6, 3.7**

  - [x]* 5.16 Write property test for ledger reconstruction
    - **Property 4: The ledger reconstructs the balances**
    - **Validates: Requirements 4.4, 4.7, 4.9**

  - [x]* 5.17 Write property test for movement reference idempotency
    - **Property 5: A movement reference can be applied at most once**
    - **Validates: Requirements 4.5, 4.6, 4.10**

  - [x]* 5.18 Write property test for rejected movement totality
    - **Property 6: Rejected movements leave the world untouched**
    - **Validates: Requirements 4.2, 4.3, 8.2, 8.8**

  - [x]* 5.19 Write property test for invalid quantity rejection
    - **Property 7: Invalid quantities are rejected identically everywhere**
    - **Validates: Requirements 4.1, 5.2, 6.13, 7.9**

  - [x] 5.20 Run the suite, commit, and push increment 5
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add inventory records, derived availability and transactional ledger"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 6. Work orders and derived shortage
  - [x] 6.1 Create the work_orders table
    - `backend/src/db/schema.sql` — `CREATE TABLE work_orders`: `location_id`, `item_id`, `required_quantity` INT UNSIGNED under `ck_work_orders_required_quantity` (`BETWEEN 1 AND 1000000`), `assigned_user_id`, `status` ENUM(`'Assigned'`, `'InProgress'`, `'Completed'`) defaulting to `'Assigned'`, nullable `status_changed_at`, nullable `created_by`, and no stored shortage column, since shortage is derived at read time and so can never go stale
    - Indexes `ix_work_orders_item_location`, `ix_work_orders_status`, `ix_work_orders_assigned_user`, `ix_work_orders_created_by`; foreign keys to `locations`, `items` and `users` ON DELETE RESTRICT, with `fk_work_orders_created_by` ON DELETE SET NULL
    - _Requirements: 5.1, 5.4_

  - [x] 6.2 Implement the work order service
    - `backend/src/services/workOrder.service.js` — `createWorkOrder` (existence checks → `INVALID_REFERENCE`, status `Assigned`), `listWorkOrders` and `getWorkOrder` computing `locationAvailableQuantity` and `shortageQuantity = max(0, required - available)` at read time via `availability.js`, `NOT_FOUND` on unmatched ids, and the named guard `nextWorkOrderStatus` used by `changeStatus` to record `statusChangedAt` or throw `INVALID_STATUS_TRANSITION`
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.12, 15.5_

  - [x] 6.3 Add the work order validation schemas
    - `backend/src/validation/workOrder.schemas.js` — strict creation body, status-change body limited to the three enum values, `objectId` path params, list query filters
    - _Requirements: 5.2, 5.11, 9.2, 9.10_

  - [x] 6.4 Wire the work order routes
    - `backend/src/controllers/workOrder.controller.js` and `backend/src/routes/workOrder.routes.js` — `GET /api/work-orders`, `GET /api/work-orders/:id`, `POST /api/work-orders` (Admin), `PATCH /api/work-orders/:id/status`; mount in `backend/src/routes/index.js` and confirm both write routes resolve against `WRITE_ROUTE_PERMISSIONS`
    - _Requirements: 2.2, 2.3, 2.14, 5.1, 5.7_

  - [x] 6.5 Extend the seed script with a shortage work order
    - `backend/scripts/seed.js` — add at least one Work_Order whose `requiredQuantity` exceeds the Location_Available_Quantity of its item at its location, so a non-zero shortage is observable
    - _Requirements: 13.5_

  - [x]* 6.6 Write unit tests for work orders
    - `backend/tests/workOrders.test.js` — 201 payload with shortage, required 100 vs available 60 → 40, surplus → 0, accepted and rejected transitions, `NOT_FOUND`, out-of-enum status → `VALIDATION_ERROR`
    - _Requirements: 5.1, 5.5, 5.6, 5.7, 5.9, 5.11, 5.12_

  - [x]* 6.7 Write property test for shortage derivation
    - `backend/tests/properties/workOrders.pbt.test.js`
    - **Property 8: Work order shortage is derived and bounded**
    - **Validates: Requirements 5.1, 5.4, 5.6, 5.10**

  - [x]* 6.8 Write property test for guarded status transitions
    - **Property 9: A status change is accepted exactly when it is the successor**
    - **Validates: Requirements 5.7, 5.9, 5.11, 6.5, 6.10**

  - [x] 6.9 Run the suite, commit, and push increment 6
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add work orders with read-time material shortage calculation"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 7. Internal stock transfers
  - [x] 7.1 Create the internal_transfers table
    - `backend/src/db/schema.sql` — `CREATE TABLE internal_transfers`: `item_id`, `batch`, `source_location_id`, `destination_location_id`, `quantity` under `ck_internal_transfers_quantity` (`BETWEEN 1 AND 1000000`), `received_quantity` defaulting to 0 and kept as its own column rather than derived from `status` so a later partial receipt needs no schema change, `status` ENUM(`'Requested'`, `'Dispatched'`, `'Received'`) defaulting to `'Requested'`, nullable `dispatched_at` and `received_at`
    - `ck_internal_transfers_received_lte_quantity` so a receipt can never book in more than was sent, and `ck_internal_transfers_distinct_locations` so no code path can create a same-location transfer; indexes `ix_internal_transfers_status`, `ix_internal_transfers_item_source_batch`, `ix_internal_transfers_destination`, `ix_internal_transfers_created_by`, plus the foreign keys to `items`, `locations` (twice) and `users`
    - _Requirements: 6.1, 15.2_

  - [x] 7.2 Implement the transfer service
    - `backend/src/services/transfer.service.js` — named guards `assertDifferentLocations` (`SAME_LOCATION_TRANSFER`) and `assertTransferTransition` (`INVALID_STATUS_TRANSITION`); `createTransfer` with existence checks including the source Inventory_Record (`INVALID_REFERENCE`) and no inventory write; `dispatchTransfer` inside `withTransaction`, locking the transfer row with `SELECT ... FOR UPDATE` and calling `applyMovement` with `-quantity` at the source under `transferMovementReference(id, 'DISPATCH')`; `receiveTransfer` inside `withTransaction` increasing or creating the destination record, setting `received_quantity` and `received_at`, using `transferMovementReference(id, 'RECEIPT')` and mapping the `ER_DUP_ENTRY` on that unique movement reference to `TRANSFER_ALREADY_RECEIVED`; `NOT_FOUND` on unmatched ids
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.14, 6.15, 15.2, 15.5_

  - [x] 7.3 Add the transfer validation schemas
    - `backend/src/validation/transfer.schemas.js` — strict creation body, empty dispatch and receive bodies, `objectId` path params, list query filter
    - _Requirements: 6.13, 9.2, 9.10_

  - [x] 7.4 Wire the transfer routes
    - `backend/src/controllers/transfer.controller.js` and `backend/src/routes/transfer.routes.js` — `GET /api/transfers`, `POST /api/transfers`, `POST /api/transfers/:id/dispatch`, `POST /api/transfers/:id/receive`; mount in `backend/src/routes/index.js`
    - _Requirements: 2.4, 2.5, 6.1, 6.4, 6.7_

  - [x] 7.5 Write mandatory test 2: over-availability dispatch
    - `backend/tests/transfers.test.js` — dispatch of a quantity above source availability returns 409 `INSUFFICIENT_AVAILABLE_QUANTITY`, the source physical quantity equals the value read immediately before, and the status stays `Requested`; issued over HTTP
    - _Requirements: 6.5, 12.2, 12.13_

  - [x] 7.6 Write mandatory test 3: three-point destination reading
    - Extend `backend/tests/transfers.test.js` — destination physical quantity before dispatch, while `Dispatched`, and after `Received`; first two readings equal, third equals the first plus the transfer quantity
    - _Requirements: 6.3, 6.6, 6.7, 12.3, 12.13_

  - [x] 7.7 Write mandatory test 4: second receipt rejected
    - Extend `backend/tests/transfers.test.js` — a second receipt returns 409 `TRANSFER_ALREADY_RECEIVED` and the destination physical quantity equals the value read after the first accepted receipt
    - _Requirements: 6.9, 12.4, 12.13_

  - [x]* 7.8 Write unit tests for the transfer creation guards
    - Extend `backend/tests/transfers.test.js` — same-location rejection, unknown references, unknown source batch, invalid quantity, unmatched transfer id, and out-of-order dispatch/receive
    - _Requirements: 6.2, 6.10, 6.13, 6.14, 6.15_

  - [x]* 7.9 Write property test for transfer conservation
    - `backend/tests/properties/transfers.pbt.test.js`
    - **Property 10: Transfers conserve quantity and hide stock in transit**
    - **Validates: Requirements 6.3, 6.4, 6.6, 6.7, 6.8, 6.11**

  - [x]* 7.10 Write property test for receipt idempotence
    - **Property 11: Receipt is idempotent and received quantity stays bounded**
    - **Validates: Requirements 6.9, 6.12, 15.2**

  - [x] 7.11 Run the suite, commit, and push increment 7
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add internal transfers with dispatch and receipt lifecycle"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 8. Customer orders and stock reservation
  - [x] 8.1 Create the customer_orders table and its reservation child table
    - `backend/src/db/schema.sql` — `CREATE TABLE customer_orders`: `customer_name` VARCHAR(120), `item_id`, `location_id`, `quantity` under `ck_customer_orders_quantity`, `status` ENUM(`'Reserved'`, `'Cancelled'`) defaulting to `'Reserved'`, nullable `created_by`, indexes `ix_customer_orders_item_location`, `ix_customer_orders_status`, `ix_customer_orders_created_by`
    - `CREATE TABLE customer_order_reservations` — the reservation lines as a child table with one row per batch drawn from (`customer_order_id`, `item_id`, `location_id`, `batch`, `quantity` under `ck_reservation_quantity`), `uq_reservation_order_batch` because an order draws from any batch exactly once in its single ascending pass, `ix_reservation_item_location_batch`, and `fk_reservation_order` ON DELETE CASCADE — the one cascade in the schema, since a line has no meaning without its order
    - `backend/src/db/mappers.js` — `toCustomerOrder(row, reservationRows)` and `toReservation`, which rebuild the order response with its lines nested, so the documented response shape is unchanged by the lines living in their own table
    - _Requirements: 7.1, 7.11, 15.3_

  - [x] 8.2 Implement the order service
    - `backend/src/services/order.service.js` — `createOrder` inside `withTransaction` with existence checks (`INVALID_REFERENCE`), and `reserveAcrossBatches` selecting the records for the item and location with `ORDER BY batch ... FOR UPDATE` so a competing reservation blocks rather than reading a value about to go stale, taking `min(remaining, availableQuantity(record))`, applying each increment through a conditional `UPDATE inventory_records SET reserved_quantity = reserved_quantity + ? WHERE id = ? AND (physical_quantity - reserved_quantity) >= ?` whose predicate comes from `hasAvailableAtLeastSql(take)`, deciding on `affectedRows === 1` and never on the prior read, writing one ledger row per changed record with `reserveMovementReference(orderId, recordId)`, inserting one `customer_order_reservations` row per line, and throwing `INSUFFICIENT_AVAILABLE_QUANTITY` when the predicate matches nothing or `remaining > 0` at the end; `getOrder`/`listOrders` with `NOT_FOUND`, loading every order's lines in one query rather than one per order
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.10, 7.12, 15.3, 15.5, 15.6_

  - [x] 8.3 Add the order validation schemas
    - `backend/src/validation/order.schemas.js` — strict creation body (`customerName`, `item`, `location`, `quantity`), `objectId` path param, list query filter
    - _Requirements: 7.9, 7.11, 9.2, 9.10_

  - [x] 8.4 Wire the order routes
    - `backend/src/controllers/order.controller.js` and `backend/src/routes/order.routes.js` — `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders`; mount in `backend/src/routes/index.js`
    - _Requirements: 2.6, 2.7, 7.1_

  - [x] 8.5 Write mandatory test 1: reservation above availability
    - `backend/tests/orders.test.js` — a creation request for a quantity above the location availability returns 409 `INSUFFICIENT_AVAILABLE_QUANTITY`, no Customer_Order row and no reservation line exists for it, and the reserved quantity of every affected record equals the value read immediately before; issued over HTTP
    - _Requirements: 7.3, 12.1, 12.13_

  - [x]* 8.6 Write unit tests for reservation allocation
    - Extend `backend/tests/orders.test.js` — reserve 60 of 100 → physical 100 / reserved 60 / available 40, multi-batch allocation in ascending batch order with one ledger row per changed record, unknown references, blank customer name, invalid quantity, unmatched order id
    - _Requirements: 7.1, 7.2, 7.9, 7.10, 7.11, 7.12_

  - [x]* 8.7 Write property test for reservation completeness
    - `backend/tests/properties/orders.pbt.test.js`
    - **Property 12: A reservation exactly covers its order, in ascending batch order**
    - **Validates: Requirements 7.1, 7.3, 15.3, 15.6**

  - [x] 8.8 Run the suite, commit, and push increment 8
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add customer orders with ascending-batch stock reservation"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 9. Concurrency and transaction hardening
  - [x] 9.1 Harden retry and connection hygiene
    - Review `backend/src/db/withTransaction.js` against the retry rule: a fresh pooled connection per attempt so a retry re-runs from the first read, swallowed rollback errors, `connection.release()` on every exit path, only `ER_LOCK_DEADLOCK` and `ER_LOCK_WAIT_TIMEOUT` treated as transient, `CONCURRENT_MODIFICATION` after the fourth attempt
    - Add `backend/tests/setup/poolCount.js` — `getInUseConnectionCount` and `getOpenConnectionCount` over the pool's own lists, so a test can compare in-use pooled connections before and after a request; a connection that is never released stays checked out and the pool blocks once `connectionLimit` of them accumulate
    - _Requirements: 8.2, 8.3, 8.5_

  - [x] 9.2 Write the concurrency tests
    - `backend/tests/concurrency.test.js` — availability 100 with unawaited orders of 80 and 50 via `Promise.allSettled`: exactly one 201, one 409 `INSUFFICIENT_AVAILABLE_QUANTITY`, exactly one order row, reserved up by exactly the committed quantity; plus two unawaited receipts for one transfer: exactly one commit, the other 409 `TRANSFER_ALREADY_RECEIVED`
    - _Requirements: 6.16, 7.5, 7.6, 7.7, 12.6, 12.13_

  - [x]* 9.3 Write unit tests for transaction behaviour
    - `backend/tests/transactions.test.js` — rollback totality on an injected mid-transaction failure, the in-use pooled connection count returning to baseline, retry count and `CONCURRENT_MODIFICATION` at exhaustion, and a graceful shutdown smoke test
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.8_

  - [x]* 9.4 Write property test for concurrent reservation safety
    - `backend/tests/properties/orders.pbt.test.js`
    - **Property 13: Concurrent reservations can never oversell**
    - **Validates: Requirements 7.5, 7.6, 7.7**

  - [x]* 9.5 Write property test for reservation confluence
    - **Property 14: Reservation outcome is order-independent**
    - **Validates: Requirements 7.8**

  - [x]* 9.6 Write property test for connection and retry bounds
    - `backend/tests/properties/api.pbt.test.js`
    - **Property 17: Connections and retries are bounded**
    - **Validates: Requirements 8.3, 8.5**

  - [x]* 9.7 Write property test for the rejected-request contract
    - **Property 15: Every rejected request answers from the declared code table and changes nothing**
    - **Validates: Requirements 3.11, 5.3, 5.12, 6.14, 6.15, 7.10, 7.11, 7.12, 9.2, 9.4, 9.5, 9.6, 9.7, 9.9, 9.10, 9.12**

  - [x]* 9.8 Write property test for authentication and role enforcement
    - **Property 16: Authentication and role enforcement hold across the route table**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.7, 1.8, 1.9, 1.11, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.12, 2.13**

  - [x] 9.9 Run the suite, commit, and push increment 9
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add concurrency and transaction hardening tests with retry bounds"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [x] 10. Frontend: five screens wired to the API
  - [x] 10.1 Scaffold the Vite React app
    - `frontend/package.json` (react, react-dom, react-router-dom; dev: vite, @vitejs/plugin-react, vitest, @testing-library/react, @testing-library/jest-dom, jsdom), `frontend/vite.config.js` that throws when `VITE_API_BASE_URL` is absent, empty, or whitespace, `frontend/index.html`, `frontend/src/main.jsx`, `frontend/.env.example`
    - _Requirements: 10.8, 10.11_

  - [x] 10.2 Implement the API client
    - `frontend/src/api/client.js` — base URL from `import.meta.env.VITE_API_BASE_URL` with no fallback, Bearer header from stored token, global 401 handling that clears the session and signals a session-ended redirect, `ApiError` carrying `code` and `message` for every other non-2xx response
    - _Requirements: 10.8, 11.3, 11.4, 11.12_

  - [x] 10.3 Implement the auth context and route guard
    - `frontend/src/auth/AuthContext.jsx` — `{ token, user, login, logout }` persisted in localStorage under one key, `login` posting to `/api/auth/login` and navigating to Inventory
    - `frontend/src/components/RequireAuth.jsx` — renders the Login screen and issues no API request when no token is held
    - _Requirements: 11.2, 11.4, 11.17, 2.10_

  - [x] 10.4 Wire the router, navigation, and the mirrored permission map
    - `frontend/src/App.jsx` — exactly five screen routes and a catch-all redirect, no sixth screen
    - `frontend/src/auth/permissions.js` — the write-route-to-role constant mirroring `backend/src/permissions.js`, plus `canWrite(routeKey, role)`
    - `frontend/src/components/Nav.jsx` — navigation entries hidden when the session role is not permitted, nothing rendered before login
    - _Requirements: 2.9, 2.10, 11.1_

  - [x] 10.5 Build the Login screen
    - `frontend/src/screens/LoginScreen.jsx` — submits credentials, retains the email value on rejection, shows a credentials-rejected message, stores nothing on failure, disables the submit control while the request is in flight
    - _Requirements: 11.2, 11.13, 11.16_

  - [x] 10.6 Build the Inventory screen and shared display components
    - `frontend/src/components/DataTable.jsx`, `ErrorBanner.jsx`, `EmptyState.jsx`
    - `frontend/src/screens/InventoryScreen.jsx` — lists item, category, location, batch, physical, reserved, and available quantity taken from the API response
    - _Requirements: 11.5, 11.12, 11.15_

  - [x] 10.7 Build the Work Orders screen
    - `frontend/src/screens/WorkOrdersScreen.jsx` — lists id, location, item, required quantity, assigned user, status, shortage; Admin-only creation form; status-change control gated by the mirrored map; refetch after a successful write
    - _Requirements: 11.6, 11.7, 11.13, 11.14_

  - [x] 10.8 Build the Internal Transfers screen
    - `frontend/src/screens/TransfersScreen.jsx` — lists id, source, destination, item, batch, quantity, status; dispatch control only on `Requested` rows and receipt control only on `Dispatched` rows for Admin/OperationsUser, neither on `Received` rows; refetch after a successful write
    - _Requirements: 11.8, 11.9, 11.13, 11.14_

  - [x] 10.9 Build the Customer Orders screen
    - `frontend/src/screens/CustomerOrdersScreen.jsx` — lists customer name, item, location, quantity, status; creation form rendered on this screen only and only for SalesUser/Admin; refetch after a successful write
    - _Requirements: 11.10, 11.11, 11.13, 11.14_

  - [x] 10.10 Set up the frontend test runner
    - `frontend/vitest.config.js` (jsdom environment), `frontend/src/test/setup.js` (jest-dom matchers), a mocked API client module, and the `test` script in `frontend/package.json`
    - _Requirements: 11.1_

  - [x]* 10.11 Write component tests for the five screens
    - `frontend/src/screens/*.test.jsx` — rendered columns per screen, role gating of forms and row controls, empty-state message, disabled-while-busy control, login failure retaining the email
    - _Requirements: 11.1, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.13, 11.15, 11.16_

  - [x]* 10.12 Write property test for the API client contract
    - `frontend/src/api/client.test.js`
    - **Property 19: The client attaches the token and reacts to every 401**
    - **Validates: Requirements 11.3, 11.4, 11.12, 11.14**

  - [x] 10.13 Run both suites, commit, and push increment 10
    - Run `npm test` in `backend/` and `npm test` in `frontend/`; commit only when both exit 0
    - `git commit -m "Add React frontend with five screens and role-gated controls"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.3, 14.7_

- [x] 11. Documentation set
  - [x] 11.1 Write the README
    - `README.md` — tech stack, minimum Node.js and MySQL versions (8.0.16, the floor for enforced `CHECK` constraints), numbered setup steps, database setup ending in `npm run migrate`, a note that no clustering or special deployment shape is needed because InnoDB is transactional on an ordinary standalone server, the full environment variable table with purpose/required/range/non-credential example, the verbatim commands to run the API server, the web client, the seed script, and the test suite, the seeded user emails with their roles and the environment variable supplying each password, the InnoDB requirement and the 3-retry limit, and links to the other documents
    - _Requirements: 8.6, 10.7, 13.1, 13.5, 13.7, 13.8_

  - [x] 11.2 Write the database schema document with the ER diagram source
    - `docs/database-schema.md` — every table with each column, its type, and whether it is nullable, every foreign key with the table and column it references and its referential actions, every unique index, and every `CHECK` constraint
    - `docs/er-diagram.mmd` — the tracked Mermaid ER diagram source, embedded by reference in the schema document
    - _Requirements: 13.2_

  - [x] 11.3 Write the API documentation
    - `docs/api.md` — for every route: method, path, permitted role set, request schema, success response schema with status, every error code with its HTTP status, and one example request body and success response; plus the complete error code list and the exact required environment variable list
    - _Requirements: 13.3, 13.9_

  - [x] 11.4 Write the data-integrity and extensibility documents
    - `docs/data-integrity.md` — which inventory invariants the database enforces and through which constraint, how `withTransaction` acquires and releases its connection and which errors it retries, how the unique `movement_reference` makes a replayed movement impossible to apply twice, and how the row lock plus the availability predicate in the `WHERE` clause make concurrent reservations safe
    - `docs/extensibility.md` — for each of adding a damaged quantity, partial transfer receipt, cancelling an order and releasing its reservation, and restricting a user to their assigned location: the module, the named function, and the schema columns to edit
    - _Requirements: 13.4, 15.7_

  - [x]* 11.5 Write a documentation consistency test
    - `backend/tests/docs.test.js` — asserts that the route table in `docs/api.md` matches the routes the app declares, that its error code list matches the keys of `src/errors/errorCodes.js`, and that its environment variable list matches the required set in `src/config/index.js`
    - _Requirements: 13.9_

  - [x] 11.6 Run the suite, commit, and push the documentation increment
    - Run `npm test` in `backend/`; commit only on exit 0
    - `git commit -m "Add README, schema, API and extensibility documentation"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.3, 14.7_

## Notes

- Tasks marked with `*` are optional. They cover the unit tests, property-based tests, and generator infrastructure, and can be deferred for a faster path through the increments.
- The tests that Requirement 12 names explicitly — mandatory tests 1 through 5 (tasks 5.12, 7.5, 7.6, 7.7, 8.5) and the concurrency test (task 9.2) — are **not** optional, because they are part of the submission itself.
- Every increment's final sub-task runs the suite before committing, so no pushed commit leaves the tests failing (Req 14.7).
- Property tests use fast-check with at least 25 runs and report the failing seed, so a counterexample is reproducible (Req 12.7).
- Properties 15, 16, and 17 are written in task 9 rather than earlier because each ranges over the complete route table, which only exists once tasks 5 through 8 have landed. Property 18 is written in task 1 with the config loader.
- Mandatory test 5 lands in task 5.12 rather than task 3, because the assertion that a targeted row is unchanged needs a real restricted write route, and `POST /api/inventory/:id/adjust` is the first one to exist. Task 3.3 covers the role matrix and the permission map completeness check.
- `inventory_records` declares the `(item_id, location_id, batch)` key pattern once, as `uq_inventory_item_location_batch`; the only other index on the table is `ix_inventory_location`, which exists because a `WHERE location_id = ?` read cannot use the unique index rather than as a duplicate of it (task 5.1).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.7"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["1.6", "1.8"] },
    { "id": 5, "tasks": ["1.9", "1.10", "1.11"] },
    { "id": 6, "tasks": ["1.12"] },
    { "id": 7, "tasks": ["2.1", "2.3"] },
    { "id": 8, "tasks": ["2.2", "2.4"] },
    { "id": 9, "tasks": ["2.5"] },
    { "id": 10, "tasks": ["2.6"] },
    { "id": 11, "tasks": ["2.7"] },
    { "id": 12, "tasks": ["2.8"] },
    { "id": 13, "tasks": ["3.1"] },
    { "id": 14, "tasks": ["3.2"] },
    { "id": 15, "tasks": ["3.3"] },
    { "id": 16, "tasks": ["3.4"] },
    { "id": 17, "tasks": ["4.1"] },
    { "id": 18, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 19, "tasks": ["4.5"] },
    { "id": 20, "tasks": ["4.6"] },
    { "id": 21, "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5"] },
    { "id": 22, "tasks": ["5.6", "5.7"] },
    { "id": 23, "tasks": ["5.8"] },
    { "id": 24, "tasks": ["5.9", "5.10"] },
    { "id": 25, "tasks": ["5.11", "5.13"] },
    { "id": 26, "tasks": ["5.12", "5.14"] },
    { "id": 27, "tasks": ["5.15"] },
    { "id": 28, "tasks": ["5.16"] },
    { "id": 29, "tasks": ["5.17"] },
    { "id": 30, "tasks": ["5.18"] },
    { "id": 31, "tasks": ["5.19"] },
    { "id": 32, "tasks": ["5.20"] },
    { "id": 33, "tasks": ["6.1"] },
    { "id": 34, "tasks": ["6.2", "6.3"] },
    { "id": 35, "tasks": ["6.4"] },
    { "id": 36, "tasks": ["6.5", "6.6"] },
    { "id": 37, "tasks": ["6.7"] },
    { "id": 38, "tasks": ["6.8"] },
    { "id": 39, "tasks": ["6.9"] },
    { "id": 40, "tasks": ["7.1"] },
    { "id": 41, "tasks": ["7.2", "7.3"] },
    { "id": 42, "tasks": ["7.4"] },
    { "id": 43, "tasks": ["7.5"] },
    { "id": 44, "tasks": ["7.6"] },
    { "id": 45, "tasks": ["7.7"] },
    { "id": 46, "tasks": ["7.8"] },
    { "id": 47, "tasks": ["7.9"] },
    { "id": 48, "tasks": ["7.10"] },
    { "id": 49, "tasks": ["7.11"] },
    { "id": 50, "tasks": ["8.1"] },
    { "id": 51, "tasks": ["8.2", "8.3"] },
    { "id": 52, "tasks": ["8.4"] },
    { "id": 53, "tasks": ["8.5"] },
    { "id": 54, "tasks": ["8.6"] },
    { "id": 55, "tasks": ["8.7"] },
    { "id": 56, "tasks": ["8.8"] },
    { "id": 57, "tasks": ["9.1"] },
    { "id": 58, "tasks": ["9.2"] },
    { "id": 59, "tasks": ["9.3"] },
    { "id": 60, "tasks": ["9.4"] },
    { "id": 61, "tasks": ["9.5"] },
    { "id": 62, "tasks": ["9.6"] },
    { "id": 63, "tasks": ["9.7"] },
    { "id": 64, "tasks": ["9.8"] },
    { "id": 65, "tasks": ["9.9"] },
    { "id": 66, "tasks": ["10.1"] },
    { "id": 67, "tasks": ["10.2", "10.3"] },
    { "id": 68, "tasks": ["10.4", "10.10"] },
    { "id": 69, "tasks": ["10.5", "10.6"] },
    { "id": 70, "tasks": ["10.7", "10.8", "10.9"] },
    { "id": 71, "tasks": ["10.11"] },
    { "id": 72, "tasks": ["10.12"] },
    { "id": 73, "tasks": ["10.13"] },
    { "id": 74, "tasks": ["11.1", "11.2", "11.3", "11.4"] },
    { "id": 75, "tasks": ["11.5"] },
    { "id": 76, "tasks": ["11.6"] }
  ]
}
```

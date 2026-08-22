# Implementation Plan: Mini Operations ERP

## Overview

Eleven top-level tasks that follow the ten increments of the design's Incremental Delivery Plan (increment 10 is split into frontend and documentation so no commit introduces more than three capabilities, Req 14.3). Stack is MERN in plain JavaScript, no TypeScript: `backend/` (Express + Mongoose, Jest + Supertest + `mongodb-memory-server` single-node replica set + fast-check) and `frontend/` (Vite + React, Vitest + React Testing Library), both at the repository root.

Every top-level task ends with a sub-task that runs the test suite and then stages, commits, and pushes to `https://github.com/Varundhyani69/FundsRoomRound2`, so the repository history shows the increments (Req 14.1, 14.2, 14.7). Nothing is committed before task 1.1 has verified the remote.

Scope discipline: no file, function, or abstraction beyond what design.md names. Layering is routes → controllers → services → models plus middleware, and every quantity comparison and status transition lives in a named exported service function (Req 15.5).

## Tasks

- [x] 1. Repository setup, project skeleton, cross-cutting middleware, and test harness
  - [x] 1.1 Initialise and verify the git remote and repository hygiene
    - Run `git status` / `git remote -v`; if no repository exists run `git init`, and if no `origin` exists add `https://github.com/Varundhyani69/FundsRoomRound2`
    - Confirm the default branch name and that `git fetch origin` reaches the remote before any code is committed
    - Create `.gitignore` at the repository root excluding `node_modules/`, `.env`, `.env.*` (but not `.env.example`), `coverage/`, `dist/`
    - Create a placeholder `README.md` naming the project and stack (expanded in task 11)
    - _Requirements: 14.2, 14.4, 14.5_

  - [x] 1.2 Create the backend package and folder skeleton
    - `backend/package.json` with scripts `start`, `dev`, `test` (`jest --runInBand`), `seed`; dependencies `express`, `mongoose`, `bcrypt`, `jsonwebtoken`, `zod`, `cors`, `dotenv`; devDependencies `jest`, `supertest`, `mongodb-memory-server`, `fast-check` — all at pinned versions
    - Create the empty directory layout from design.md: `backend/src/{config,db,models,middleware,errors,services,controllers,routes,validation}`, `backend/scripts`, `backend/tests/setup`
    - `backend/.env.example` listing `MONGODB_URI`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN`, `SEED_ADMIN_PASSWORD`, `SEED_OPS_PASSWORD`, `SEED_SALES_PASSWORD` with placeholder non-credential values
    - _Requirements: 10.6, 10.7, 14.6_

  - [x] 1.3 Implement the config loader
    - `backend/src/config/index.js` — the only module that reads `process.env`; exactly four required variables, single stderr message naming every missing one, `process.exit(1)`, port range 1–65535 check, `JWT_SECRET` length ≥ 32 check, no defaults
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
    - `backend/src/server.js` — config → connect → listen, plus `SIGINT`/`SIGTERM` handling that closes the server and the Mongoose connection, exits 0, and forces `process.exit(1)` after a 10-second deadline
    - _Requirements: 8.4, 9.1, 12.13_

  - [x] 1.7 Implement the database connection module
    - `backend/src/db/connect.js` — `mongoose.connect` with the configured URI and a startup log line stating whether the deployment reports a replica-set name
    - _Requirements: 8.1, 8.6_

  - [x] 1.8 Build the test harness with the in-memory replica set
    - `backend/jest.config.js` — `globalSetup`, `globalTeardown`, `setupFilesAfterEnv`, `testEnvironment: 'node'`, serial execution
    - `backend/tests/setup/globalSetup.js` — `MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })`, sets `MONGODB_URI`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN`
    - `backend/tests/setup/globalTeardown.js` — stops the replica set
    - `backend/tests/setup/assertReplicaSet.js` — `hello` command check, stderr reason and non-zero exit when no `setName` is reported, run before any test
    - `backend/tests/setup/dbSetup.js` — connect once, `beforeEach` deletion of every document in every collection, disconnect after all
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
  - [x] 2.1 Create the User model
    - `backend/src/models/User.js` — unique lowercase trimmed `email` (≤ 254), `passwordHash` with `select: false`, `role` enum, nullable `assignedLocation` ObjectId reference, timestamps
    - _Requirements: 1.1, 1.5, 15.4_

  - [x] 2.2 Implement the auth service
    - `backend/src/services/auth.service.js` — `login(email, password)`: lookup with `+passwordHash`, `bcrypt.compare`, identical `INVALID_CREDENTIALS` AppError for unmatched email and failed comparison, `jsonwebtoken.sign({ sub, role }, config.jwtSecret, { expiresIn: '8h' })`, and a `hashPassword` helper at cost 10 used by the seed script
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
    - Note: mandatory test 5 needs a real restricted write route with a targeted document, so it is added to this same file in task 5.12, as soon as `POST /api/inventory` exists
    - _Requirements: 2.1, 2.3, 2.5, 2.7, 2.8, 2.11, 2.12, 2.13, 2.14_

  - [x] 3.4 Run the suite, commit, and push increment 3
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add role-based authorization with a single write-route permission map"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [ ] 4. Reference data and the seed script
  - [x] 4.1 Create the reference data models
    - `backend/src/models/Category.js` (unique `name`), `backend/src/models/Item.js` (unique `code`, `name`, required `category` ObjectId reference, non-unique `category` index), `backend/src/models/Location.js` (unique `code`, `name`)
    - _Requirements: 3.2_

  - [x] 4.2 Add the reference list routes
    - `backend/src/controllers/reference.controller.js` and `backend/src/routes/reference.routes.js` — `GET /api/items` (with populated category), `GET /api/locations`, `GET /api/users` (id, email, role only)
    - Mount in `backend/src/routes/index.js` behind `authenticate` + `authorize`
    - _Requirements: 2.13, 3.2_

  - [x] 4.3 Write the non-interactive seed script
    - `backend/scripts/seed.js` — validates `SEED_ADMIN_PASSWORD`, `SEED_OPS_PASSWORD`, `SEED_SALES_PASSWORD` and exits non-zero when any is absent; creates one Admin, one Operations_User, one Sales_User, two Locations, one Category, and two Items; idempotent by upsert on the unique keys; requires no interactive input
    - Add the `seed` script entry to `backend/package.json`
    - _Requirements: 13.5, 13.8, 14.5_

  - [x] 4.4 Extend the per-test seed fixture with reference data
    - `backend/tests/setup/seedFixture.js` — add two Locations, one Category, two Items, and set `assignedLocation` on the seeded Operations_User
    - _Requirements: 12.11_

  - [x]* 4.5 Write unit tests for the reference routes
    - `backend/tests/reference.test.js` — authenticated list responses and shapes, 401 without a token
    - _Requirements: 2.13, 3.2_

  - [-] 4.6 Run the suite, commit, and push increment 4
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add category, item and location reference data with seed script"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [ ] 5. Inventory core: availability, transactions, records, and ledger
  - [ ] 5.1 Create the shared field helpers and the InventoryRecord model
    - `backend/src/models/fields.js` — `nonNegativeCount` (integer 0..999,999,999) and `validQuantity` (integer 1..1,000,000)
    - `backend/src/models/InventoryRecord.js` — `item`, `location`, trimmed `batch` 1..32, `physicalQuantity`, `reservedQuantity`, an `availableQuantity` virtual that delegates to `availableQuantity(record)`, and no stored available field
    - Declare the `{ item: 1, location: 1, batch: 1 }` index **once**, as the unique index only; do not add the redundant non-unique duplicate of the same key pattern shown in design.md
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.10_

  - [ ] 5.2 Create the append-only InventoryTransaction model
    - `backend/src/models/InventoryTransaction.js` — `inventoryRecord`, signed integer `physicalDelta` and `reservedDelta`, unique `movementReference`, `appliedAt`, nullable `createdBy`; indexes `{ movementReference: 1 }` unique and `{ inventoryRecord: 1, appliedAt: 1 }`; pre-hooks rejecting every update and delete operation
    - _Requirements: 4.4, 4.5, 4.7, 4.10_

  - [ ] 5.3 Implement the availability module
    - `backend/src/services/availability.js` — `availableQuantity(record)`, `locationAvailableQuantity(records)`, `hasAvailableAtLeastExpr(quantity)`; the only module in the codebase that subtracts `reservedQuantity` from `physicalQuantity`
    - _Requirements: 3.3, 3.4, 3.5, 3.12, 15.1_

  - [ ] 5.4 Implement the transaction helper
    - `backend/src/db/withTransaction.js` — fresh session per attempt, `startTransaction`, commit on success, abort on any error, `endSession()` in `finally`, transient-label retry up to 3 times (4 attempts), then `CONCURRENT_MODIFICATION` 409
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [ ] 5.5 Implement the movement reference builders
    - `backend/src/services/movementReference.js` — `openingMovementReference`, `adjustMovementReference`, `transferMovementReference`, `reserveMovementReference` exactly as named in design.md
    - _Requirements: 4.5, 4.6, 4.9_

  - [ ] 5.6 Implement the inventory service
    - `backend/src/services/inventory.service.js` — `applyMovement` (the one place that writes a record change and its ledger row in the caller's session, using a conditional update whose filter carries the availability/non-negativity condition and mapping `error.code === 11000` to `DUPLICATE_INVENTORY_TRANSACTION`), named guards `assertSufficientPhysical` and `assertSufficientAvailable`, `createRecord` (pre-generated `_id`, existence checks returning `INVALID_REFERENCE`, duplicate triple returning `DUPLICATE_INVENTORY_RECORD`, opening ledger row in the same transaction), `adjustRecord` (`IN`/`OUT`), `listRecords`, `getLocationAvailability` (0 when no records)
    - _Requirements: 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 4.2, 4.3, 4.4, 4.6, 4.9, 8.1, 15.5_

  - [ ] 5.7 Add the inventory validation schemas and quantity error code selection
    - `backend/src/validation/inventory.schemas.js` — strict bodies for create (`item`, `location`, `batch`, `physicalQuantity`, `movementReference`) and adjust (`direction`, `quantity`, `movementReference`), plus the `?item&location` query schemas
    - Extend `backend/src/middleware/validate.js` so a failure whose issue paths all name a quantity field reports `INVALID_QUANTITY` and mixed failures fall back to `VALIDATION_ERROR`
    - _Requirements: 4.1, 4.8, 9.2, 9.3, 9.4_

  - [ ] 5.8 Wire the inventory routes
    - `backend/src/controllers/inventory.controller.js` (reads `req.validated` and `req.user` only, no quantity comparisons) and `backend/src/routes/inventory.routes.js` — `GET /api/inventory`, `GET /api/inventory/availability`, `POST /api/inventory`, `POST /api/inventory/:id/adjust` with `authorize` and `validate` attached per route
    - Mount in `backend/src/routes/index.js`
    - _Requirements: 2.4, 2.5, 3.3, 3.5, 9.1, 15.5_

  - [ ] 5.9 Extend the seed script and the test fixture with inventory records
    - `backend/scripts/seed.js` — add at least one Inventory_Record whose Available_Quantity is ≥ 1 at a location usable as a transfer source
    - `backend/tests/setup/seedFixture.js` — add two Inventory_Records with stated physical and reserved quantities
    - _Requirements: 12.11, 13.5_

  - [ ]* 5.10 Add the shared property test generators
    - `backend/tests/setup/generators.js` — `genQuantity`, `genInvalidQuantity`, `genBatch`, `genRecordLayout`, `genOperationSequence`, `genUnusedObjectId`, `genMalformedId`, `genRole`, `genConcurrentQuantities`; fast-check configured with `numRuns: 25` minimum and counterexample seed reporting
    - _Requirements: 12.7_

  - [ ]* 5.11 Write unit tests for inventory creation, adjustment, and reads
    - `backend/tests/inventory.test.js` — 100/30 → 70 example, duplicate triple 409, `INVALID_REFERENCE`, opening ledger row contents, adjustment guards, availability read of 0 when no record exists
    - _Requirements: 3.4, 3.7, 3.11, 3.12, 4.2, 4.3, 4.9_

  - [ ] 5.12 Write mandatory test 5 against a real restricted write route
    - Extend `backend/tests/authorization.test.js` — a Sales_User token calling `POST /api/inventory/:id/adjust` receives 403 `FORBIDDEN`, and every field of the targeted Inventory_Record equals the value read immediately before the request; issued over HTTP through the app
    - _Requirements: 2.5, 12.5, 12.13_

  - [ ]* 5.13 Write property test for derived availability
    - `backend/tests/properties/inventory.pbt.test.js`
    - **Property 1: Available quantity is always the derived difference**
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.12, 15.1**

  - [ ]* 5.14 Write property test for the inventory invariants
    - **Property 2: Inventory invariants survive every accepted operation**
    - **Validates: Requirements 3.8, 3.9**

  - [ ]* 5.15 Write property test for record identity
    - **Property 3: Item, location, and batch identify at most one record**
    - **Validates: Requirements 3.6, 3.7**

  - [ ]* 5.16 Write property test for ledger reconstruction
    - **Property 4: The ledger reconstructs the balances**
    - **Validates: Requirements 4.4, 4.7, 4.9**

  - [ ]* 5.17 Write property test for movement reference idempotency
    - **Property 5: A movement reference can be applied at most once**
    - **Validates: Requirements 4.5, 4.6, 4.10**

  - [ ]* 5.18 Write property test for rejected movement totality
    - **Property 6: Rejected movements leave the world untouched**
    - **Validates: Requirements 4.2, 4.3, 8.2, 8.8**

  - [ ]* 5.19 Write property test for invalid quantity rejection
    - **Property 7: Invalid quantities are rejected identically everywhere**
    - **Validates: Requirements 4.1, 5.2, 6.13, 7.9**

  - [ ] 5.20 Run the suite, commit, and push increment 5
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add inventory records, derived availability and transactional ledger"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [ ] 6. Work orders and derived shortage
  - [ ] 6.1 Create the WorkOrder model
    - `backend/src/models/WorkOrder.js` — `location`, `item`, `requiredQuantity` (`validQuantity`), `assignedUser`, `status` enum defaulting to `Assigned`, nullable `statusChangedAt`, `createdBy`, indexes `{ item, location }` and `{ status }`, and no stored shortage field
    - _Requirements: 5.1, 5.4_

  - [ ] 6.2 Implement the work order service
    - `backend/src/services/workOrder.service.js` — `createWorkOrder` (existence checks → `INVALID_REFERENCE`, status `Assigned`), `listWorkOrders` and `getWorkOrder` computing `locationAvailableQuantity` and `shortageQuantity = max(0, required - available)` at read time via `availability.js`, `NOT_FOUND` on unmatched ids, and the named guard `nextWorkOrderStatus` used by `changeStatus` to record `statusChangedAt` or throw `INVALID_STATUS_TRANSITION`
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.12, 15.5_

  - [ ] 6.3 Add the work order validation schemas
    - `backend/src/validation/workOrder.schemas.js` — strict creation body, status-change body limited to the three enum values, `objectId` path params, list query filters
    - _Requirements: 5.2, 5.11, 9.2, 9.10_

  - [ ] 6.4 Wire the work order routes
    - `backend/src/controllers/workOrder.controller.js` and `backend/src/routes/workOrder.routes.js` — `GET /api/work-orders`, `GET /api/work-orders/:id`, `POST /api/work-orders` (Admin), `PATCH /api/work-orders/:id/status`; mount in `backend/src/routes/index.js` and confirm both write routes resolve against `WRITE_ROUTE_PERMISSIONS`
    - _Requirements: 2.2, 2.3, 2.14, 5.1, 5.7_

  - [ ] 6.5 Extend the seed script with a shortage work order
    - `backend/scripts/seed.js` — add at least one Work_Order whose `requiredQuantity` exceeds the Location_Available_Quantity of its item at its location, so a non-zero shortage is observable
    - _Requirements: 13.5_

  - [ ]* 6.6 Write unit tests for work orders
    - `backend/tests/workOrders.test.js` — 201 payload with shortage, required 100 vs available 60 → 40, surplus → 0, accepted and rejected transitions, `NOT_FOUND`, out-of-enum status → `VALIDATION_ERROR`
    - _Requirements: 5.1, 5.5, 5.6, 5.7, 5.9, 5.11, 5.12_

  - [ ]* 6.7 Write property test for shortage derivation
    - `backend/tests/properties/workOrders.pbt.test.js`
    - **Property 8: Work order shortage is derived and bounded**
    - **Validates: Requirements 5.1, 5.4, 5.6, 5.10**

  - [ ]* 6.8 Write property test for guarded status transitions
    - **Property 9: A status change is accepted exactly when it is the successor**
    - **Validates: Requirements 5.7, 5.9, 5.11, 6.5, 6.10**

  - [ ] 6.9 Run the suite, commit, and push increment 6
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add work orders with read-time material shortage calculation"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [ ] 7. Internal stock transfers
  - [ ] 7.1 Create the InternalTransfer model
    - `backend/src/models/InternalTransfer.js` — `item`, trimmed `batch`, `sourceLocation`, `destinationLocation`, `quantity` (`validQuantity`), `receivedQuantity` bounded by `quantity`, `status` enum defaulting to `Requested`, nullable `dispatchedAt` and `receivedAt`, indexes `{ status }` and `{ item, sourceLocation, batch }`
    - _Requirements: 6.1, 15.2_

  - [ ] 7.2 Implement the transfer service
    - `backend/src/services/transfer.service.js` — named guards `assertDifferentLocations` (`SAME_LOCATION_TRANSFER`) and `assertTransferTransition` (`INVALID_STATUS_TRANSITION`); `createTransfer` with existence checks including the source Inventory_Record (`INVALID_REFERENCE`) and no inventory write; `dispatchTransfer` inside `withTransaction` calling `applyMovement` with `-quantity` at the source and `transferMovementReference(id, 'DISPATCH')`; `receiveTransfer` inside `withTransaction` increasing or creating the destination record, setting `receivedQuantity` and `receivedAt`, using `transferMovementReference(id, 'RECEIPT')` and mapping the duplicate-key signal to `TRANSFER_ALREADY_RECEIVED`; `NOT_FOUND` on unmatched ids
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.14, 6.15, 15.2, 15.5_

  - [ ] 7.3 Add the transfer validation schemas
    - `backend/src/validation/transfer.schemas.js` — strict creation body, empty dispatch and receive bodies, `objectId` path params, list query filter
    - _Requirements: 6.13, 9.2, 9.10_

  - [ ] 7.4 Wire the transfer routes
    - `backend/src/controllers/transfer.controller.js` and `backend/src/routes/transfer.routes.js` — `GET /api/transfers`, `POST /api/transfers`, `POST /api/transfers/:id/dispatch`, `POST /api/transfers/:id/receive`; mount in `backend/src/routes/index.js`
    - _Requirements: 2.4, 2.5, 6.1, 6.4, 6.7_

  - [ ] 7.5 Write mandatory test 2: over-availability dispatch
    - `backend/tests/transfers.test.js` — dispatch of a quantity above source availability returns 409 `INSUFFICIENT_AVAILABLE_QUANTITY`, the source physical quantity equals the value read immediately before, and the status stays `Requested`; issued over HTTP
    - _Requirements: 6.5, 12.2, 12.13_

  - [ ] 7.6 Write mandatory test 3: three-point destination reading
    - Extend `backend/tests/transfers.test.js` — destination physical quantity before dispatch, while `Dispatched`, and after `Received`; first two readings equal, third equals the first plus the transfer quantity
    - _Requirements: 6.3, 6.6, 6.7, 12.3, 12.13_

  - [ ] 7.7 Write mandatory test 4: second receipt rejected
    - Extend `backend/tests/transfers.test.js` — a second receipt returns 409 `TRANSFER_ALREADY_RECEIVED` and the destination physical quantity equals the value read after the first accepted receipt
    - _Requirements: 6.9, 12.4, 12.13_

  - [ ]* 7.8 Write unit tests for the transfer creation guards
    - Extend `backend/tests/transfers.test.js` — same-location rejection, unknown references, unknown source batch, invalid quantity, unmatched transfer id, and out-of-order dispatch/receive
    - _Requirements: 6.2, 6.10, 6.13, 6.14, 6.15_

  - [ ]* 7.9 Write property test for transfer conservation
    - `backend/tests/properties/transfers.pbt.test.js`
    - **Property 10: Transfers conserve quantity and hide stock in transit**
    - **Validates: Requirements 6.3, 6.4, 6.6, 6.7, 6.8, 6.11**

  - [ ]* 7.10 Write property test for receipt idempotence
    - **Property 11: Receipt is idempotent and received quantity stays bounded**
    - **Validates: Requirements 6.9, 6.12, 15.2**

  - [ ] 7.11 Run the suite, commit, and push increment 7
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add internal transfers with dispatch and receipt lifecycle"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [ ] 8. Customer orders and stock reservation
  - [ ] 8.1 Create the CustomerOrder model
    - `backend/src/models/CustomerOrder.js` — embedded `reservationEntrySchema` (`item`, `location`, `batch`, `quantity`, `_id: false`), `customerName` 1..120 trimmed, `item`, `location`, `quantity`, `status` enum defaulting to `Reserved`, `reservations` validated to hold 1..20 entries, `createdBy`, indexes `{ item, location }` and `{ status }`
    - _Requirements: 7.1, 7.11, 15.3_

  - [ ] 8.2 Implement the order service
    - `backend/src/services/order.service.js` — `createOrder` inside `withTransaction` with existence checks (`INVALID_REFERENCE`), and `reserveAcrossBatches` scanning records for the item and location sorted `{ batch: 1 }`, taking `min(remaining, availableQuantity(record))`, applying each increment through `updateOne` whose filter carries `hasAvailableAtLeastExpr(take)`, deciding on `matchedCount === 1`, writing one ledger row per changed record with `reserveMovementReference(orderId, recordId)`, and throwing `INSUFFICIENT_AVAILABLE_QUANTITY` when a filter misses or `remaining > 0` at the end; `getOrder`/`listOrders` with `NOT_FOUND`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.10, 7.12, 15.3, 15.5, 15.6_

  - [ ] 8.3 Add the order validation schemas
    - `backend/src/validation/order.schemas.js` — strict creation body (`customerName`, `item`, `location`, `quantity`), `objectId` path param, list query filter
    - _Requirements: 7.9, 7.11, 9.2, 9.10_

  - [ ] 8.4 Wire the order routes
    - `backend/src/controllers/order.controller.js` and `backend/src/routes/order.routes.js` — `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders`; mount in `backend/src/routes/index.js`
    - _Requirements: 2.6, 2.7, 7.1_

  - [ ] 8.5 Write mandatory test 1: reservation above availability
    - `backend/tests/orders.test.js` — a creation request for a quantity above the location availability returns 409 `INSUFFICIENT_AVAILABLE_QUANTITY`, no Customer_Order document exists for it, and the reserved quantity of every affected record equals the value read immediately before; issued over HTTP
    - _Requirements: 7.3, 12.1, 12.13_

  - [ ]* 8.6 Write unit tests for reservation allocation
    - Extend `backend/tests/orders.test.js` — reserve 60 of 100 → physical 100 / reserved 60 / available 40, multi-batch allocation in ascending batch order with one ledger row per changed record, unknown references, blank customer name, invalid quantity, unmatched order id
    - _Requirements: 7.1, 7.2, 7.9, 7.10, 7.11, 7.12_

  - [ ]* 8.7 Write property test for reservation completeness
    - `backend/tests/properties/orders.pbt.test.js`
    - **Property 12: A reservation exactly covers its order, in ascending batch order**
    - **Validates: Requirements 7.1, 7.3, 15.3, 15.6**

  - [ ] 8.8 Run the suite, commit, and push increment 8
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add customer orders with ascending-batch stock reservation"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [ ] 9. Concurrency and transaction hardening
  - [ ] 9.1 Harden retry and session hygiene
    - Review `backend/src/db/withTransaction.js` against the retry rule: fresh session per attempt so a retry re-runs from the first read, swallowed abort errors, `endSession()` on every exit path, `CONCURRENT_MODIFICATION` after the fourth attempt
    - Add `backend/tests/setup/sessionCount.js` — reads the server's open session count so tests can compare before and after a request
    - _Requirements: 8.2, 8.3, 8.5_

  - [ ] 9.2 Write the concurrency tests
    - `backend/tests/concurrency.test.js` — availability 100 with unawaited orders of 80 and 50 via `Promise.allSettled`: exactly one 201, one 409 `INSUFFICIENT_AVAILABLE_QUANTITY`, exactly one order document, reserved up by exactly the committed quantity; plus two unawaited receipts for one transfer: exactly one commit, the other 409 `TRANSFER_ALREADY_RECEIVED`
    - _Requirements: 6.16, 7.5, 7.6, 7.7, 12.6, 12.13_

  - [ ]* 9.3 Write unit tests for transaction behaviour
    - `backend/tests/transactions.test.js` — rollback totality on an injected mid-transaction failure, open session count returning to baseline, retry count and `CONCURRENT_MODIFICATION` at exhaustion, and a graceful shutdown smoke test
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.8_

  - [ ]* 9.4 Write property test for concurrent reservation safety
    - `backend/tests/properties/orders.pbt.test.js`
    - **Property 13: Concurrent reservations can never oversell**
    - **Validates: Requirements 7.5, 7.6, 7.7**

  - [ ]* 9.5 Write property test for reservation confluence
    - **Property 14: Reservation outcome is order-independent**
    - **Validates: Requirements 7.8**

  - [ ]* 9.6 Write property test for session and retry bounds
    - `backend/tests/properties/api.pbt.test.js`
    - **Property 17: Sessions and retries are bounded**
    - **Validates: Requirements 8.3, 8.5**

  - [ ]* 9.7 Write property test for the rejected-request contract
    - **Property 15: Every rejected request answers from the declared code table and changes nothing**
    - **Validates: Requirements 3.11, 5.3, 5.12, 6.14, 6.15, 7.10, 7.11, 7.12, 9.2, 9.4, 9.5, 9.6, 9.7, 9.9, 9.10, 9.12**

  - [ ]* 9.8 Write property test for authentication and role enforcement
    - **Property 16: Authentication and role enforcement hold across the route table**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.7, 1.8, 1.9, 1.11, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.12, 2.13**

  - [ ] 9.9 Run the suite, commit, and push increment 9
    - Run `npm test`; commit only on exit 0
    - `git commit -m "Add concurrency and transaction hardening tests with retry bounds"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.7_

- [ ] 10. Frontend: five screens wired to the API
  - [ ] 10.1 Scaffold the Vite React app
    - `frontend/package.json` (react, react-dom, react-router-dom; dev: vite, @vitejs/plugin-react, vitest, @testing-library/react, @testing-library/jest-dom, jsdom), `frontend/vite.config.js` that throws when `VITE_API_BASE_URL` is absent, empty, or whitespace, `frontend/index.html`, `frontend/src/main.jsx`, `frontend/.env.example`
    - _Requirements: 10.8, 10.11_

  - [ ] 10.2 Implement the API client
    - `frontend/src/api/client.js` — base URL from `import.meta.env.VITE_API_BASE_URL` with no fallback, Bearer header from stored token, global 401 handling that clears the session and signals a session-ended redirect, `ApiError` carrying `code` and `message` for every other non-2xx response
    - _Requirements: 10.8, 11.3, 11.4, 11.12_

  - [ ] 10.3 Implement the auth context and route guard
    - `frontend/src/auth/AuthContext.jsx` — `{ token, user, login, logout }` persisted in localStorage under one key, `login` posting to `/api/auth/login` and navigating to Inventory
    - `frontend/src/components/RequireAuth.jsx` — renders the Login screen and issues no API request when no token is held
    - _Requirements: 11.2, 11.4, 11.17, 2.10_

  - [ ] 10.4 Wire the router, navigation, and the mirrored permission map
    - `frontend/src/App.jsx` — exactly five screen routes and a catch-all redirect, no sixth screen
    - `frontend/src/auth/permissions.js` — the write-route-to-role constant mirroring `backend/src/permissions.js`, plus `canWrite(routeKey, role)`
    - `frontend/src/components/Nav.jsx` — navigation entries hidden when the session role is not permitted, nothing rendered before login
    - _Requirements: 2.9, 2.10, 11.1_

  - [ ] 10.5 Build the Login screen
    - `frontend/src/screens/LoginScreen.jsx` — submits credentials, retains the email value on rejection, shows a credentials-rejected message, stores nothing on failure, disables the submit control while the request is in flight
    - _Requirements: 11.2, 11.13, 11.16_

  - [ ] 10.6 Build the Inventory screen and shared display components
    - `frontend/src/components/DataTable.jsx`, `ErrorBanner.jsx`, `EmptyState.jsx`
    - `frontend/src/screens/InventoryScreen.jsx` — lists item, category, location, batch, physical, reserved, and available quantity taken from the API response
    - _Requirements: 11.5, 11.12, 11.15_

  - [ ] 10.7 Build the Work Orders screen
    - `frontend/src/screens/WorkOrdersScreen.jsx` — lists id, location, item, required quantity, assigned user, status, shortage; Admin-only creation form; status-change control gated by the mirrored map; refetch after a successful write
    - _Requirements: 11.6, 11.7, 11.13, 11.14_

  - [ ] 10.8 Build the Internal Transfers screen
    - `frontend/src/screens/TransfersScreen.jsx` — lists id, source, destination, item, batch, quantity, status; dispatch control only on `Requested` rows and receipt control only on `Dispatched` rows for Admin/OperationsUser, neither on `Received` rows; refetch after a successful write
    - _Requirements: 11.8, 11.9, 11.13, 11.14_

  - [ ] 10.9 Build the Customer Orders screen
    - `frontend/src/screens/CustomerOrdersScreen.jsx` — lists customer name, item, location, quantity, status; creation form rendered on this screen only and only for SalesUser/Admin; refetch after a successful write
    - _Requirements: 11.10, 11.11, 11.13, 11.14_

  - [ ] 10.10 Set up the frontend test runner
    - `frontend/vitest.config.js` (jsdom environment), `frontend/src/test/setup.js` (jest-dom matchers), a mocked API client module, and the `test` script in `frontend/package.json`
    - _Requirements: 11.1_

  - [ ]* 10.11 Write component tests for the five screens
    - `frontend/src/screens/*.test.jsx` — rendered columns per screen, role gating of forms and row controls, empty-state message, disabled-while-busy control, login failure retaining the email
    - _Requirements: 11.1, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.13, 11.15, 11.16_

  - [ ]* 10.12 Write property test for the API client contract
    - `frontend/src/api/client.test.js`
    - **Property 19: The client attaches the token and reacts to every 401**
    - **Validates: Requirements 11.3, 11.4, 11.12, 11.14**

  - [ ] 10.13 Run both suites, commit, and push increment 10
    - Run `npm test` in `backend/` and `npm test` in `frontend/`; commit only when both exit 0
    - `git commit -m "Add React frontend with five screens and role-gated controls"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.3, 14.7_

- [ ] 11. Documentation set
  - [ ] 11.1 Write the README
    - `README.md` — tech stack, minimum Node.js and MongoDB versions, numbered setup steps, database setup including the `rs.initiate()` replica-set step, the full environment variable table with purpose/required/range/non-credential example, the verbatim commands to run the API server, the web client, the seed script, and the test suite, the seeded user emails with their roles and the environment variable supplying each password, the replica-set reason and the 3-retry limit, and links to the other documents
    - _Requirements: 8.6, 10.7, 13.1, 13.5, 13.7, 13.8_

  - [ ] 11.2 Write the database schema document with the ER diagram source
    - `docs/database-schema.md` — every collection with each field, its type, and whether it is required or optional, every reference field with its target collection, and every unique index
    - `docs/er-diagram.mmd` — the tracked Mermaid ER diagram source, embedded by reference in the schema document
    - _Requirements: 13.2_

  - [ ] 11.3 Write the API documentation
    - `docs/api.md` — for every route: method, path, permitted role set, request schema, success response schema with status, every error code with its HTTP status, and one example request body and success response; plus the complete error code list and the exact required environment variable list
    - _Requirements: 13.3, 13.9_

  - [ ] 11.4 Write the deviation and extensibility documents
    - `docs/mongodb-deviation.md` — MongoDB replacing the relational database of the brief, how ObjectId references and multi-document transactions preserve its intent, and the accepted trade-offs (application-enforced referential integrity, replica-set requirement)
    - `docs/extensibility.md` — for each of adding a damaged quantity, partial transfer receipt, cancelling an order and releasing its reservation, and restricting a user to their assigned location: the module, the named function, and the schema fields to edit
    - _Requirements: 13.4, 15.7_

  - [ ]* 11.5 Write a documentation consistency test
    - `backend/tests/docs.test.js` — asserts that the route table in `docs/api.md` matches the routes the app declares, that its error code list matches the keys of `src/errors/errorCodes.js`, and that its environment variable list matches the required set in `src/config/index.js`
    - _Requirements: 13.9_

  - [ ] 11.6 Run the suite, commit, and push the documentation increment
    - Run `npm test` in `backend/`; commit only on exit 0
    - `git commit -m "Add README, schema, API and extensibility documentation"`, then `git push`
    - _Requirements: 14.1, 14.2, 14.3, 14.7_

## Notes

- Tasks marked with `*` are optional. They cover the unit tests, property-based tests, and generator infrastructure, and can be deferred for a faster path through the increments.
- The tests that Requirement 12 names explicitly — mandatory tests 1 through 5 (tasks 5.12, 7.5, 7.6, 7.7, 8.5) and the concurrency test (task 9.2) — are **not** optional, because they are part of the submission itself.
- Every increment's final sub-task runs the suite before committing, so no pushed commit leaves the tests failing (Req 14.7).
- Property tests use fast-check with at least 25 runs and report the failing seed, so a counterexample is reproducible (Req 12.7).
- Properties 15, 16, and 17 are written in task 9 rather than earlier because each ranges over the complete route table, which only exists once tasks 5 through 8 have landed. Property 18 is written in task 1 with the config loader.
- Mandatory test 5 lands in task 5.12 rather than task 3, because the assertion that a targeted document is unchanged needs a real restricted write route, and `POST /api/inventory/:id/adjust` is the first one to exist. Task 3.3 covers the role matrix and the permission map completeness check.
- `InventoryRecord` declares the `{ item, location, batch }` key pattern once, as the unique index. The duplicate non-unique declaration shown in design.md is deliberately omitted (task 5.1).

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

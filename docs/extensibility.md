# Extensibility

For four specific live-change requests an evaluator might ask for, this document names the
module, the named function(s) to edit, and the schema column to add or that already exists to
support the change. **None of these changes are implemented** — this is a description of what a
small change would actually touch, grounded in the code as it exists today.

The relational schema lives in one file,
[`backend/src/db/schema.sql`](../backend/src/db/schema.sql), and there is no ORM, so every
change below is "edit this SQL, edit this service function" rather than "edit a model and hope
nothing else restated the rule."

## 1. Adding a damaged quantity that reduces available stock

**Modules:** `backend/src/services/availability.js` and `backend/src/db/schema.sql`.

**Functions to edit:** `availableQuantity(record)`, and the two SQL forms of the same rule,
`AVAILABLE_SQL` and `AVAILABLE_SQL_FOR(alias)`.

`availability.js` is the only module in the codebase that subtracts `reserved_quantity` from
`physical_quantity`, and it deliberately holds three shapes of that one rule:

| Export | Shape | Consumed by |
|---|---|---|
| `availableQuantity(record)` | JavaScript | Every read path and in-process guard |
| `AVAILABLE_SQL`, `AVAILABLE_SQL_FOR(alias)` | SQL expression | The `SELECT`s that project availability as a derived column |
| `hasAvailableAtLeastSql(qty)` | SQL predicate + bound param | The `WHERE` clause of every conditional `UPDATE` |

The change is to subtract a new `damaged_quantity` in `availableQuantity`, and add the same
column to `AVAILABLE_SQL` and `AVAILABLE_SQL_FOR`. `hasAvailableAtLeastSql` is built on top of
those two, so every conditional update's guard follows automatically and the database-side
check cannot drift from the JavaScript-side check.

**Schema change:** add `damaged_quantity INT UNSIGNED NOT NULL DEFAULT 0` to
`inventory_records` in `schema.sql`, alongside `physical_quantity` and `reserved_quantity` and
matching their `UNSIGNED` type so the database refuses a negative. Then extend
`ck_inventory_reserved_lte_physical` — currently `reserved_quantity <= physical_quantity` — to
`reserved_quantity + damaged_quantity <= physical_quantity`, so the invariant that makes
available quantity non-negative stays true against the new definition. That is the part worth
noticing: because the invariant is a `CHECK` constraint rather than only an `if` in a service,
changing the availability formula forces you to restate the invariant in the schema too, and
the database will then hold it.

Since the schema is applied by `CREATE TABLE IF NOT EXISTS`, an existing database also needs a
migration statement (`ALTER TABLE inventory_records ADD COLUMN ...`) — `scripts/migrate.js`
applies `schema.sql` idempotently but does not diff existing tables against it.

**Honest scope note:** genuinely small on the read side, because every availability read and
every quantity guard across Work_Order_Service, Transfer_Service, and Order_Service calls into
this one module instead of repeating the subtraction. What it does *not* include is any route
or service function that actually *sets* `damaged_quantity` to a non-zero value — there is no
"mark N units damaged" operation anywhere. Adding the column and the subtraction is small;
adding a damage-reporting workflow (a mutation path, a new movement-reference kind, a ledger
delta, validation, authorization) is a separate, larger piece of work.

## 2. Allowing a transfer to be partially received

**Module:** `backend/src/services/transfer.service.js`

**Function to edit:** `receiveTransfer`.

Today `receiveTransfer` always books in the full amount: it calls `applyMovement` with
`physicalDelta: transfer.quantity`, then sets `received_quantity = transfer.quantity` and
`status = 'Received'` in one `UPDATE`. There is no partial path.

Supporting a partial receipt means:

1. Accepting a requested receipt quantity, rather than always using `transfer.quantity`.
2. Passing that smaller amount as `physicalDelta` to `applyMovement`.
3. Changing the `UPDATE` from `received_quantity = ?` to
   `received_quantity = received_quantity + ?`, so successive receipts accumulate.
4. Changing the movement reference. `transferMovementReference(transfer.id, 'RECEIPT')` is
   unique per transfer, which is exactly what currently makes a second receipt impossible —
   the unique index on `movement_reference` refuses it. Partial receipts need a reference that
   is unique per *receipt event*, not per transfer, or the second partial receipt would be
   rejected as a duplicate.
5. Relaxing the terminal guard. `assertTransferTransition`'s `Received`-to-`Received` carve-out
   throws `TRANSFER_ALREADY_RECEIVED`; the new rule is that a transfer reaches `Received` only
   once `received_quantity` equals `quantity`, and stays `Dispatched` (or a new intermediate
   status) while any amount is outstanding.

**Schema already in place:** `internal_transfers.received_quantity` exists as its own
`INT UNSIGNED` column rather than being derived from `status`, and
`ck_internal_transfers_received_lte_quantity` bounds it above by the transfer's own `quantity`
rather than by a fixed number. The column comment in `schema.sql` states this was deliberate:
it can hold any value strictly between 0 and `quantity` without a schema change, and the
constraint guarantees a partial-receipt implementation still cannot book in more than was
sent. That part really is already done.

**Honest scope note:** the schema is ready and the constraint is already the right one, but
point 4 is the trap — the idempotency mechanism that currently protects against a double
receipt is the same mechanism a partial receipt has to work around, and getting that wrong
either breaks partial receipts or silently reopens the double-apply hole. Plus the API request
shape for `POST /api/transfers/:id/receive` would need to accept a quantity instead of the
fixed empty body it takes today, with a new zod schema. Moderate change, concentrated in one
function, one reference builder, and one route.

## 3. Cancelling a customer order and releasing its reservation

**Module:** `backend/src/services/order.service.js`

**Function to add:** a new `cancelOrder(orderId)`. There is no cancellation today —
`order.service.js` exports `createOrder`, `listOrders`, `getOrder`, `findOrderById`, and
`reserveAcrossBatches`, and `customer_orders.status` already has `'Cancelled'` in its `ENUM`
with nothing that ever sets it.

The new function would, inside one `withTransaction` call:

1. `SELECT ... FOR UPDATE` the order row, reject with `NOT_FOUND` if absent and with a new
   code (or `INVALID_STATUS_TRANSITION`) if `status` is already `'Cancelled'`. The row lock is
   what makes two concurrent cancellations of one order safe.
2. Read the order's rows from `customer_order_reservations` — the existing `loadReservations`
   already does exactly this query.
3. For each line, find the `inventory_records` row it names by `(item_id, location_id, batch)`
   and decrease its `reserved_quantity` by the line's `quantity`, as a guarded conditional
   update in the same style as `reserveAcrossBatches`:
   `UPDATE inventory_records SET reserved_quantity = reserved_quantity - ? WHERE id = ? AND reserved_quantity >= ?`,
   deciding on `affectedRows` — not a blind decrement.
4. Write one `inventory_transactions` row per changed record with a **negative**
   `reserved_delta`, using a cancellation-specific movement reference so the unique index makes
   a replayed cancellation fail rather than double-release.
5. Set the order's `status` to `'Cancelled'`.

**Schema already in place:** `customer_order_reservations`. Each row already names exactly one
`item_id`, `location_id`, `batch`, and `quantity` — precisely the four pieces of information
needed to find the `inventory_records` row a line drew from and release the right amount from
it. No ledger scan, no reconstruction: one indexed lookup per line.
`ix_reservation_item_location_batch` even serves the reverse direction if you ever need "which
orders hold stock in this batch."

The `reserved_quantity >= ?` guard in step 3 is not paranoia — it is the mirror of the
availability guard, and it means a release can never drive `reserved_quantity` negative even if
the lines and the balances somehow disagreed. `INT UNSIGNED` on the column would refuse it
anyway, but with an out-of-range driver error rather than a clean 409.

**Honest scope note:** the data needed is already sitting in the child table, which makes the
core loop straightforward. Undecided: the API surface (`POST /api/orders/:id/cancel`, an entry
in `WRITE_ROUTE_PERMISSIONS`, an empty-body zod schema, a new error code for
"already cancelled"), and the new movement-reference kind in `movementReference.js`. Small, but
it touches five files.

## 4. Restricting a user to their assigned location

**Modules:** `backend/src/middleware/authorize.js` and `backend/src/middleware/authenticate.js`

**What to add:** a location comparison alongside the existing role check in `authorize`. Today
`authorize` checks two things and nothing else: that `req.user.role` is one of the three
declared roles, and that the role appears in `WRITE_ROUTE_PERMISSIONS` for the matched route
key. It has no notion of location.

The change: for write routes whose body or resolved resource names a location — creating an
`inventory_record`, dispatching or receiving an `internal_transfer`, creating a `work_order` —
compare `req.user.assignedLocation` against that route's location and call `next(forbidden())`
when they differ and `assignedLocation` is not null. In plain language: "if this user is tied
to a site and the request targets a different site, deny it exactly the way an unpermitted role
is denied today," reusing the single `forbidden()` builder so every denial stays
indistinguishable to the client.

**Schema already in place:** `users.assigned_location_id` is `CHAR(24) NULL`, references
`locations(id)`, and is indexed by `ix_users_assigned_location`. `NULL` already means "not tied
to a site," which is what an Admin gets. Nothing needs to change in the schema.

**What does need changing beyond `authorize`:** `authenticate.js` puts exactly
`{ id: payload.sub, role: payload.role }` on `req.user` — deliberately, so nothing downstream
can read an undeclared claim. So the assigned location has to get there first, and there is a
real choice: add it to the JWT payload in `auth.service.js` (fast, no query per request, but
stale until the user's next login) or look it up from `users` per request (always current,
costs a query on every authenticated call). For a location assignment that changes rarely and
is a *restriction* rather than a grant, a stale value is a security-relevant staleness, which
argues for the query.

**Honest scope note:** the column exists and the role-check-first structure of `authorize` is a
reasonable place to hang a second check, but this is not a one-liner. It touches
`authenticate.js`, `authorize.js`, and probably `auth.service.js`, and — because the location
relevant to a request lives in different places for different routes (the request body for
creation, the transfer's own `source_location_id`/`destination_location_id` for
dispatch/receive, which is only known after a database read) — the comparison is not uniform.
Dispatch and receive in particular would need the middleware to read the transfer row, which
means either a query in the middleware or moving the check into the service. Deciding that,
route by route, is the actual work. A few functions across three files, not one line in one
file.

---

For how the constraints, transactions, and row locks referenced throughout this document fit
together, see [`docs/data-integrity.md`](./data-integrity.md).

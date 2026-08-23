# Data Integrity and Concurrency

This document explains how the inventory invariants are actually held, and by what. It is
written against the code as it exists: [`backend/src/db/schema.sql`](../backend/src/db/schema.sql),
[`backend/src/db/withTransaction.js`](../backend/src/db/withTransaction.js),
[`backend/src/services/availability.js`](../backend/src/services/availability.js), and
[`backend/src/services/order.service.js`](../backend/src/services/order.service.js).

There are three layers, and they are deliberately redundant:

1. **The schema** declares the invariants as `CHECK` constraints, `UNSIGNED` column types, and
   `UNIQUE` indexes, so illegal data is refused even by a path that bypasses the application.
2. **Transactions** make every multi-row write atomic, so a rejected operation leaves nothing
   behind.
3. **Row locks plus a predicate in the `UPDATE`** make the accept/reject decision for a stock
   movement belong to the database, not to a value the application read a moment earlier.

Any one of these alone would leave a gap. Together they mean there is no ordering of concurrent
requests that produces a negative or oversold balance.

---

## 1. The invariants

Stock lives in one table, `inventory_records`, one row per (item, location, batch):

| Column | Meaning |
|---|---|
| `physical_quantity` | Units actually present |
| `reserved_quantity` | Units already promised to customer orders |

Available quantity is **not stored**. It is derived, everywhere, as
`physical_quantity - reserved_quantity`. The four rules the whole application depends on:

| # | Invariant | Enforced by |
|---|---|---|
| I1 | `physical_quantity >= 0` | `INT UNSIGNED` column type |
| I2 | `reserved_quantity >= 0` | `INT UNSIGNED` column type |
| I3 | `reserved_quantity <= physical_quantity` | `CONSTRAINT ck_inventory_reserved_lte_physical` |
| I4 | `physical_quantity`, `reserved_quantity` `<= 999,999,999` | `ck_inventory_physical_max`, `ck_inventory_reserved_max` |

**I3 is the important one.** Available quantity being non-negative is not a separate rule that
has to be checked; it is a consequence of I3, and I3 is a database constraint. If application
code ever tried to reserve more than exists, MySQL would reject the statement outright with
error 3819 rather than storing an oversold row.

`INT UNSIGNED` is doing real work for I1 and I2, not just documenting intent. An `UPDATE` that
would drive either balance below zero fails with an out-of-range error instead of wrapping or
storing a negative — MySQL in strict mode (the default since 5.7) refuses the write.

### Why MySQL 8.0.16 is the floor

`CHECK` constraints were accepted-and-ignored by every earlier MySQL version: the DDL parses,
the table is created, and the constraint does nothing. On 8.0.15 this schema would apply
cleanly and silently enforce none of I3 or I4. That is why the README states 8.0.16 as a hard
minimum rather than a preference.

### The other constraints

| Constraint | Table | What it prevents |
|---|---|---|
| `uq_inventory_item_location_batch` | `inventory_records` | Two rows for the same item + location + batch, which would split one balance in two and make availability ambiguous |
| `uq_inventory_transactions_movement_reference` | `inventory_transactions` | The same logical movement being applied twice (see §3) |
| `ck_internal_transfers_distinct_locations` | `internal_transfers` | A transfer whose source and destination are the same location |
| `ck_internal_transfers_received_lte_quantity` | `internal_transfers` | A receipt booking in more units than were dispatched |
| `ck_work_orders_required_quantity`, `ck_customer_orders_quantity`, `ck_reservation_quantity` | respective tables | A quantity outside 1–1,000,000 |
| `uq_reservation_order_batch` | `customer_order_reservations` | One order holding two reservation lines against the same batch, which would mean the batch pass ran twice |

Every one of these is also checked in the service layer, so a caller gets a clean
`400`/`409` with a specific error code rather than a raw driver error. The constraints exist
because service-layer checks can be bypassed — by a migration script, an admin at a SQL
prompt, or a future code path someone forgets to guard. `backend/tests/schema.test.js` asserts
each constraint actually rejects the data it is supposed to, at the database level, with no
application code in the path.

### Case sensitivity

Every table uses `utf8mb4_0900_as_cs`, an accent- and **case-sensitive** collation. Batch
labels and item/location codes are identifiers, so `batch-a` and `BATCH-A` have to be two
different batches — and the unique indexes have to agree. MySQL's default collation
(`utf8mb4_0900_ai_ci`) is case-insensitive and would collapse them into one row, which is a
silent data-merging bug rather than an error anyone would notice.

---

## 2. Transactions

`backend/src/db/withTransaction.js` is the only place in the codebase that opens a
transaction. Services call it with a callback and perform every read and write inside on the
connection it hands them:

```js
await withTransaction(async (tx) => {
    const [rows] = await tx.query('SELECT ... FOR UPDATE', [...]);
    await tx.query('UPDATE ...', [...]);
});
```

It commits if the callback resolves, rolls back if it throws, and releases the connection on
every exit path.

### A dedicated connection per transaction

In MySQL, `BEGIN`/`COMMIT`/`ROLLBACK` are **connection state**, not parameters on a call. Two
concurrent requests sharing a pooled connection would interleave statements inside each
other's transaction, and one request's `COMMIT` would commit the other's half-finished work.
So `withTransaction` takes a connection out of the pool for the transaction's whole duration
and returns it in a `finally` block. Without that `finally`, `connectionLimit` failed requests
would exhaust the pool and the process would hang rather than error.

The corollary matters when reading the services: a query issued against the shared pool
(`query(...)` from `db/pool.js`) instead of against `tx` runs **outside** the transaction. It
is not rolled back on failure and not re-read on a retry. This is the same trap the previous
MongoDB implementation had with sessions, and it is why the wrapper passes the connection in
explicitly rather than exposing an ambient one.

### Retries, and what is not retried

Two MySQL errors mean "your transaction was rolled back for a timing reason, nothing about it
was wrong":

- `ER_LOCK_DEADLOCK` (1213) — InnoDB detected a deadlock and picked this transaction as the
  victim.
- `ER_LOCK_WAIT_TIMEOUT` (1205) — this transaction waited too long for a lock another one
  held.

Both are retried, up to **3 retries** (4 executions total), each on a fresh connection so the
callback genuinely re-runs from its first read with no state carried over. If the fourth
execution also fails transiently, the API returns `409 CONCURRENT_MODIFICATION`.

Everything else is deterministic and would fail identically on a second run — a service guard,
`ER_DUP_ENTRY` from a unique index, a `CHECK` violation, a bad column — so it propagates
immediately. Retrying those would only delay the same response.

`backend/tests/setup/assertTransactional.js` verifies at suite startup that the test database
is actually transactional (InnoDB, not MyISAM), because MyISAM accepts `BEGIN` and
`FOREIGN KEY` declarations and silently honours neither, which would void every guarantee on
this page without a single test failing.

### The ledger writes in the same transaction

Every change to an `inventory_records` row writes exactly one `inventory_transactions` row in
the **same** transaction — signed `physical_delta` and `reserved_delta` describing the change.
Because the balance update and its ledger row commit or roll back together, summing a record's
deltas always reproduces its current balance. There is no window in which the two disagree.

---

## 3. Idempotency: `movement_reference`

`inventory_transactions.movement_reference` is a unique string naming the logical movement, not
the attempt. Built by `backend/src/services/movementReference.js` from the operation and the
ids involved — for example a reservation's reference is derived from its order id and the
inventory record id.

Because the column carries a `UNIQUE` index, applying the same logical movement twice fails at
the database with `ER_DUP_ENTRY` on the second insert. The service maps that to
`409 DUPLICATE_INVENTORY_TRANSACTION` (or, in the reservation path, to
`INSUFFICIENT_AVAILABLE_QUANTITY`, since the same order reserving the same record twice means
the reservation ran twice).

This is what makes a replayed request — a client retry, a duplicate submit, a double-clicked
button — safe. It cannot double-apply, because the duplicate is refused inside the transaction
that would have applied it, so the balance change rolls back with it. Note the ordering: the
insert is inside the transaction, so the check and the write cannot be separated by a crash.

Receiving an already-received transfer is caught earlier still, by a status guard that returns
`409 TRANSFER_ALREADY_RECEIVED`; the unique reference is the backstop underneath it.

---

## 4. Concurrency: the database decides, not the read

This is the part the brief tests directly, and it is worth being precise about.

### The formula lives in exactly one file

`backend/src/services/availability.js` is the only module that subtracts `reserved_quantity`
from `physical_quantity`. It exports the rule in three shapes:

| Export | Shape | Used by |
|---|---|---|
| `availableQuantity(record)` | JavaScript | Read paths, and to size a candidate take |
| `AVAILABLE_SQL` / `AVAILABLE_SQL_FOR(alias)` | SQL expression | `SELECT`s that project availability as a derived column |
| `hasAvailableAtLeastSql(qty)` | SQL predicate + bound param | The `WHERE` clause of every conditional `UPDATE` |

No controller, no other service, and no hand-written query restates the subtraction. That is
what makes the extension in §5 a two-line change rather than a codebase-wide search.

### The unsafe pattern, and why it is unsafe

```js
// NOT what this codebase does.
const record = await read(id);
if (availableQuantity(record) >= want) {
    await increaseReserved(id, want);
}
```

Availability 100. Request A wants 80, request B wants 50, submitted together. Both read 100.
Both conclude their amount fits. Both increment. `reserved_quantity` ends at 130 against
`physical_quantity` 100 — 30 units oversold. The `if` was true when it ran and false by the
time the write landed, and nothing in that code can tell.

### What the code actually does

Two mechanisms, in `reserveAcrossBatches`:

**A row lock before the read.** The candidate rows are selected `FOR UPDATE`, in ascending
batch order:

```sql
SELECT id, batch, physical_quantity, reserved_quantity
  FROM inventory_records
 WHERE item_id = ? AND location_id = ?
 ORDER BY batch
 FOR UPDATE
```

InnoDB holds those locks until the transaction commits. A second transaction reserving from
the same batch **blocks here** rather than reading a value that is about to go stale.

**The availability check inside the write.** The `UPDATE` carries the predicate:

```sql
UPDATE inventory_records
   SET reserved_quantity = reserved_quantity + ?
 WHERE id = ? AND (physical_quantity - reserved_quantity) >= ?
```

MySQL re-evaluates that predicate at the instant the write applies. The accept/reject decision
is `result.affectedRows === 1` — never a JavaScript comparison against a number read earlier.
If `affectedRows` is 0, availability disappeared between the read and the write, and the
service throws `409 INSUFFICIENT_AVAILABLE_QUANTITY`. There is nothing left to re-check,
because the write's own result *is* the check.

### Walking the 80-and-50-against-100 race

Whichever transaction reaches `FOR UPDATE` first holds the row lock; call it A. B waits.

- A re-reads `reserved_quantity` as 0, sizes its take at 80, its predicate `100 >= 80` holds,
  `affectedRows` is 1, it inserts its ledger row and its reservation line, and commits.
- B now acquires the lock and re-reads `reserved_quantity` as **80**. Its take is recomputed
  against 20 available. Its predicate `20 >= 50` fails, `affectedRows` is 0, and it throws
  `INSUFFICIENT_AVAILABLE_QUANTITY`.
- B's whole transaction rolls back, so the `customer_orders` row it had already inserted and
  any partial reservation it made against an earlier batch are undone. A rejected reservation
  leaves no order behind.

If the two deadlock instead of queueing, InnoDB rolls one back with `ER_LOCK_DEADLOCK`,
`withTransaction` retries it from its first read, and it then sees the winner's committed
effect and is rejected on the merits. Either path: exactly one commits, and
`reserved_quantity` never exceeds `physical_quantity`.

Note that correctness here does **not** depend on the retries. The retries turn a deadlock
into a clean rejection instead of a 409-that-might-have-succeeded; the lock and the predicate
are what prevent the oversell. `backend/tests/concurrency.test.js` fires exactly this race
over real HTTP and asserts one winner, one `INSUFFICIENT_AVAILABLE_QUANTITY`, and a final
balance that never exceeds physical.

### Multi-batch reservation

An order for 100 units may draw from several batches. `reserveAcrossBatches` walks the locked
rows in ascending batch order, consuming each record's full availability before moving on, and
records one reservation line per batch drawn from in `customer_order_reservations`. Each
individual `UPDATE` carries its own guard. If the batches together cannot cover the order, the
loop ends with units still outstanding and throws — again rolling back every partial increase
it had already made. The reservation lines it returns always sum to the order quantity, or
there are no lines and no order at all.

### The same pattern elsewhere

Transfer dispatch decreases physical at the source with the mirror guard
`hasPhysicalAtLeastSql` (`physical_quantity >= ?`), rejecting with
`INSUFFICIENT_PHYSICAL_QUANTITY` on `affectedRows === 0`. Inventory adjustments go through
`applyMovement` in `inventory.service.js`, which carries a combined physical-and-available
guard. Every quantity mutation in the codebase is a guarded conditional update decided by
`affectedRows` — none is a read-then-write.

### Why not an application-level lock

An in-process mutex would work for exactly one Node process. Behind a load balancer with two
instances, or after a horizontal scale-up on AWS, it protects nothing: each process has its own
mutex and neither knows about the other. The row lock is held by the one component both
instances share. This is the same reason the availability check is a `WHERE` clause rather than
an `if`.

---

## 5. Extending the rule

Adding a further deducted component — a `damaged_quantity`, say — touches two files, because
the formula is defined once:

1. Subtract the new column in `availableQuantity` in `availability.js`.
2. Add the same column to `AVAILABLE_SQL` and `AVAILABLE_SQL_FOR` in the same file
   (`hasAvailableAtLeastSql` builds on them, so the `UPDATE` guards follow automatically).
3. Add the column to `inventory_records` in `schema.sql`, and extend
   `ck_inventory_reserved_lte_physical` to keep I3 true against the new definition.

Every read path and every conditional update then picks the new rule up unchanged. That
property only holds while nothing else restates the subtraction, which is why
`availability.js` carries a comment saying so.

See [`docs/extensibility.md`](./extensibility.md) for three further change requests worked
through the same way.

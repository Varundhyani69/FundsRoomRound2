# MongoDB Deviation

## The deviation

The original case study brief asks for a relational database. This project uses MongoDB
instead. Everything in this document explains why that substitution still honors the intent
of a relational database, and what the team gave up to make it.

## How the relational intent is preserved

**References instead of embedded copies.** Every place one document needs to point at
another — an `Inventory_Record`'s `item` and `location`, a `Work_Order`'s `assignedUser`, an
`Internal_Transfer`'s `sourceLocation` and `destinationLocation`, a `Customer_Order`'s `item`
and `location`, a `User`'s `assignedLocation` — is stored as a MongoDB `ObjectId` reference to
a document in another collection, not as a duplicated embedded copy of that document's data.
This is the same normalization a relational schema would apply with a foreign key column.
Renaming an `Item` or a `Location` is one write to that one document; nothing else in the
database goes stale, because nothing else holds a copy of its fields.

The one deliberate exception is `Customer_Order.reservations`: each entry there is a small,
self-contained record of which `Item`/`Location`/`Batch`/`Quantity` combination a reservation
drew from. It is embedded on purpose (see `docs/extensibility.md` for why), not because the
project drifted from the reference-based pattern elsewhere.

**Transactions instead of implicit relational atomicity.** A relational database's
transactions guarantee that a multi-table write either fully happens or fully does not. MongoDB
gives the same guarantee for a multi-document write through multi-document transactions,
executed within a single client session. This project never writes a balance change to an
`Inventory_Record` without writing its corresponding `Inventory_Transaction` ledger row in the
same transaction, and every service that touches more than one collection in one business
operation (dispatching a transfer, receiving a transfer, reserving a customer order) runs that
operation through `backend/src/db/withTransaction.js`. That module owns the whole lifecycle:
it starts a fresh session per attempt, starts the transaction, commits on success, aborts on
any error, always ends the session in a `finally` block, and retries up to three times when
MongoDB reports the failure as transient before giving up and reporting
`CONCURRENT_MODIFICATION`. Nothing outside that one module calls `startSession` directly, so
the atomicity guarantee lives in exactly one place.

## Accepted trade-offs

Substituting MongoDB for a relational database is not free. This project accepts three
specific costs in exchange for the benefits above:

1. **Referential integrity is enforced by the application, not by the database.** A
   relational database rejects an insert that names a foreign key with no matching row.
   MongoDB has no equivalent constraint across collections. Instead, every service that
   accepts a reference to another collection — `Inventory_Service.createRecord`,
   `Work_Order_Service.createWorkOrder`, `Transfer_Service.createTransfer`,
   `Order_Service.createOrder` — checks that the referenced document exists with an explicit
   `exists()` query before writing anything, and responds with the error code
   `INVALID_REFERENCE` when it does not. This means the constraint can, in principle, be
   bypassed by any code path that skips the service layer and writes to a collection directly
   (a migration script, a one-off shell command). A relational foreign key would catch that;
   this design relies on every write going through the service layer.

2. **The deployment requires a replica set, even a single-node one.** MongoDB
   multi-document transactions are not available against a standalone `mongod` — the
   underlying replication machinery that transactions depend on only exists once a replica
   set is configured, even a "replica set" of exactly one member. This is a real deployment
   requirement, not just a local development detail: production needs MongoDB Atlas (which is
   always a replica set) or a self-managed replica set with `rs.initiate()` run at least once.
   The automated test suite works around this by starting its own single-node replica set
   in-process with `mongodb-memory-server`, so `npm test` needs no externally running
   database, but that is a test-time convenience, not a statement that standalone MongoDB
   would work in any other environment.

3. **There is no native cross-collection JOIN.** A relational database can join two tables
   in a single query. MongoDB has no equivalent for combining data across separate top-level
   collections at the same ease and cost. Every read in this project that needs to show data
   from a referenced collection alongside the document that references it — showing an
   `Item`'s `category`, or a `Work_Order`'s `location` and `item` — uses Mongoose's
   `.populate()`, which issues a follow-up query (or a batched follow-up query) after the
   initial find and stitches the results together in the application. This is slower than a
   database-side join for large result sets and adds a round trip, but for this project's
   scale it is the same "one place, named function" pattern the rest of the design uses:
   every service that returns a document populates it through one local helper function
   (`populateTransfer`, `populateOrder`, and their equivalents), so the populate paths stay
   consistent without duplicating the `.populate()` calls everywhere a document is read.

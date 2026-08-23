# Extensibility

This document names, for four specific live-change requests an evaluator might ask for, the
module, the named function(s) to edit, and the schema field to add or that already exists to
support the change. None of these changes are implemented — this is a description of what a
small change would actually touch, grounded in the code as it exists today.

## 1. Adding a damaged quantity that reduces available stock

**Module:** `backend/src/services/availability.js`

**Functions to edit:** `availableQuantity(record)` and `hasAvailableAtLeastExpr(quantity)`.

`availableQuantity` currently returns `record.physicalQuantity - record.reservedQuantity`. It
would change to also subtract a new `damagedQuantity` field, e.g.
`record.physicalQuantity - record.reservedQuantity - record.damagedQuantity`.
`hasAvailableAtLeastExpr` builds the same rule as a MongoDB `$expr` filter fragment for
conditional updates (`$subtract: ['$physicalQuantity', '$reservedQuantity']`); its `$subtract`
array would need the same new field appended so the database-side check stays consistent with
the JavaScript-side check.

**Schema field to add:** a `damagedQuantity` field on `InventoryRecord`
(`backend/src/models/InventoryRecord.js`), most naturally reusing the existing
`nonNegativeCount` field helper from `backend/src/models/fields.js` the way
`physicalQuantity` and `reservedQuantity` already do, defaulting to 0.

**Honest scope note:** this is genuinely small on the read side, because every availability
read and every quantity guard across the whole codebase (Work_Order_Service,
Transfer_Service, Order_Service) calls into this one module rather than repeating the
subtraction. What this change does *not* include is any route or service function that
actually sets `damagedQuantity` to a non-zero value — there is currently no "mark N units
damaged" operation anywhere. Adding the field and the subtraction is small; adding a full
damage-reporting workflow (a new mutation path, a new movement reference type, a new ledger
delta, validation, authorization) would be a separate, larger piece of work.

## 2. Allowing a transfer to be partially received

**Module:** `backend/src/services/transfer.service.js`

**Function to edit:** `receiveTransfer`.

Today `receiveTransfer` always sets `transfer.receivedQuantity = transfer.quantity` and moves
`transfer.status` straight to `'Received'` — there is no partial path. Supporting a partial
receipt would mean changing the function to accept a requested receipt quantity (rather than
always receiving the full remaining amount), applying that smaller quantity to the destination
`Inventory_Record` through `applyMovement` instead of the full `transfer.quantity`, and
incrementing `receivedQuantity` by that amount rather than setting it outright. The guard that
currently treats any accepted receipt as terminal (`assertTransferTransition`'s
`Received`-to-`Received` carve-out, which throws `TRANSFER_ALREADY_RECEIVED`) would need a new
rule: a transfer should only move to `Received` once `receivedQuantity` reaches `quantity`,
and stay at `Dispatched` (or a new intermediate status) while a partial amount remains
outstanding.

**Schema field already in place:** `receivedQuantity` on `InternalTransfer`
(`backend/src/models/InternalTransfer.js`) already exists and is already bounded between 0
and the transfer's own `quantity` by a schema validator (`value <= this.quantity`), not by a
fixed number. The field's own comment in the model states this was deliberate: the upper
bound reads `this.quantity` specifically so a future partial-receipt feature can set any
intermediate value without touching the schema. That part really is already done — the field
exists precisely to make this change small on the data-model side.

**Honest scope note:** the schema is ready, but the service logic is not just a one-line
edit. Deciding what "partially received" means for `Transfer_Status` (a new status value, or
keep `Dispatched` until fully received) is a real design decision, and the API request shape
for `POST /api/transfers/:id/receive` would need to accept a quantity instead of taking a
fixed empty body as it does today. This is a moderate change concentrated in one function and
one route, not a one-line edit.

## 3. Cancelling a customer order and releasing its reservation

**Module:** `backend/src/services/order.service.js`

**Function to add:** a new function, e.g. `cancelOrder(orderId)`. There is no cancellation
function today — `order.service.js` currently exports only `reserveAcrossBatches`,
`createOrder`, `listOrders`, and `getOrder`.

The new function would look up the `CustomerOrder` by id, reject if its `status` is already
`'Cancelled'` or if the id does not exist (`NOT_FOUND`, matching the pattern `getOrder`
already uses), and otherwise, inside one `withTransaction` call, walk the order's
`reservations` list and for each entry reduce the `reservedQuantity` of the
`InventoryRecord` it names by that entry's `quantity` (the inverse of what
`reserveAcrossBatches` did when it created the reservation), writing one ledger row per
changed record the same way `reserveAcrossBatches` does today with
`reserveMovementReference`. It would then set the order's `status` to `'Cancelled'`.

**Schema field already in place:** the `reservations` entry list on `CustomerOrder`
(`backend/src/models/CustomerOrder.js`). Each entry already names exactly one `item`,
`location`, `batch`, and `quantity` — precisely the four pieces of information needed to find
the `InventoryRecord` an entry drew from and release the right amount from it. The model's own
comment states this was the reason the list is embedded on the order rather than kept only as
ledger rows: cancellation needs "no join, no ledger scan, just the entries already sitting on
the order itself." That reasoning holds up when read against the code — no other lookup is
needed to know what to release.

**Honest scope note:** the data needed to release the reservation is already sitting on the
document, which makes the core loop straightforward. What is not yet decided is the API
surface (a new route, e.g. `POST /api/orders/:id/cancel`, a new entry in
`WRITE_ROUTE_PERMISSIONS`, a new validation schema for an empty-body request) and any question
of whether the underlying `InventoryRecord` for a reservation entry could have been deleted or
changed since the reservation was made — the write would need the same guarded, filter-based
update style `reserveAcrossBatches` uses rather than a blind decrement, to stay consistent
with how every other quantity mutation in this codebase is written.

## 4. Restricting a user to their assigned location

**Module:** `backend/src/middleware/authorize.js`

**What to add:** a location-comparison check added alongside the existing role check in the
`authorize` function. Today `authorize` checks only `req.user.role` against
`WRITE_ROUTE_PERMISSIONS` — it has no notion of location at all. A location restriction would
mean, for routes whose body or resolved resource names a `location` (e.g. creating an
`Inventory_Record`, dispatching or receiving an `Internal_Transfer` at a given location,
creating a `Work_Order`), comparing `req.user.assignedLocation` against that route's location
and calling `next(forbidden())` when they differ and `assignedLocation` is not null. In plain
language: "if this user has an assigned location and the request targets a different
location, deny it the same way an unpermitted role is denied today."

**Schema field already in place:** `assignedLocation` on `User`
(`backend/src/models/User.js`) already exists, is already nullable (null meaning "not tied to
a site," as the field's own comment states), and already references a `Location` document by
`ObjectId`. `authenticate.js` does not currently attach `assignedLocation` to `req.user`
(today `req.user` is only `{ id, role }`), so part of this change is also extending what
`authenticate` puts on the request, not only what `authorize` checks.

**Honest scope note:** the field exists and the enum-role-check-first pattern in `authorize`
is a reasonable place to hang a second check, but this is not a single-line addition. It
touches `authenticate.js` (to put `assignedLocation` on `req.user`), `authorize.js` (to add
the comparison), and — because the location relevant to a request lives in different places
for different routes (the request body for creation, the route's resolved document for
dispatch/receive) — the comparison itself is not uniform across routes, so it can't be a
single generic rule without deciding, route by route, where the request's target location
comes from. It is a small, well-contained change per the design's intent, but "small" here
means a few functions across two files, not one line in one file.

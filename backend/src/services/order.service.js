// backend/src/services/order.service.js -- the Order_Service: creates Customer_Orders by
// reserving stock out of InventoryRecord Available_Quantity, and reads them back (Req 7.1,
// 7.2, 7.3, 7.4, 7.10, 7.12, 15.3, 15.5, 15.6).
//
// `reserveAcrossBatches` is the single most important function in this codebase. It is the
// one place a reservation decision is made, and the decision comes from the MATCH RESULT of a
// conditional database update, never from a value read earlier in the same function (Req 7.4,
// 15.5). Read its comments carefully before changing it -- see "WHY THIS DEFEATS THE RACE"
// below for the reasoning that makes concurrent reservation requests safe.
//
// `createOrder` runs the whole thing inside one `withTransaction` call: the reservation loop
// and the CustomerOrder insert commit together, or neither happens (Req 8.1). Existence
// checks for `item` and `location` happen first, the same way workOrder.service.js's
// `createWorkOrder` and transfer.service.js's `createTransfer` check their references before
// opening a transaction -- a request naming an unknown item or location never needs a
// transaction at all.

const mongoose = require('mongoose');

const CustomerOrder = require('../models/CustomerOrder');
const InventoryRecord = require('../models/InventoryRecord');
const InventoryTransaction = require('../models/InventoryTransaction');
const Item = require('../models/Item');
const Location = require('../models/Location');
const { withTransaction } = require('../db/withTransaction');
const { availableQuantity, hasAvailableAtLeastExpr } = require('./availability');
const { reserveMovementReference } = require('./movementReference');
const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

// Built fresh per call, the same way inventory.service.js's, transfer.service.js's, and
// workOrder.service.js's error factories are, so each thrown error carries its own stack.
const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'The referenced item or location does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'Customer order not found.');

const insufficientAvailableQuantity = () =>
    new AppError(
        ERROR_CODES.INSUFFICIENT_AVAILABLE_QUANTITY,
        'INSUFFICIENT_AVAILABLE_QUANTITY',
        'Not enough available quantity to reserve this order.'
    );

/**
 * Populates a CustomerOrder document the same way for create, list, and get, so the response
 * shape never drifts between endpoints. `reservations` entries are left as raw `item`/
 * `location` ids, matching design.md's own API response example -- they are already scoped
 * to a batch of the order's own item and location, so re-populating them here would only
 * repeat information already on the parent document (Req 15.3).
 *
 * @param {import('mongoose').Query} query
 * @returns {import('mongoose').Query}
 */
function populateOrder(query) {
    return query
        .populate({ path: 'item', populate: { path: 'category' } })
        .populate('location');
}

/**
 * Reserves `quantity` units of one Item at one Location by increasing the Reserved_Quantity
 * of its InventoryRecord documents in ascending Batch order, consuming each record's full
 * Available_Quantity before moving to the next (Req 7.1).
 *
 * THE DECISION, NOT THE READ (Req 7.4, 15.5): the `records` read below only picks candidate
 * batches and a `take` size to attempt. It never decides whether the reservation succeeds.
 * The decision is `result.matchedCount === 1` on a conditional update whose filter re-checks
 * availability at the instant MongoDB applies it. If the filter no longer matches -- because
 * another transaction reserved from the same record in between this function's read and its
 * write -- the update matches nothing and this throws immediately. Nothing here ever compares
 * a remembered availability number against `take` to make the accept/reject call; the update
 * result is the call.
 *
 * WHY THIS DEFEATS THE RACE: take Available_Quantity 100, with two overlapping requests, A
 * reserving 80 and B reserving 50, both inside their own `withTransaction` callback.
 *
 *   A naive read-then-write implementation would have both requests read 100, both conclude
 *   "80 (or 50) fits", both `$inc` reservedQuantity, and the record would end up with
 *   Reserved_Quantity 130 against Physical_Quantity 100 -- an oversell (Req 7.6).
 *
 *   Here, both transactions attempt to `updateOne` the SAME InventoryRecord document at
 *   roughly the same time. MongoDB's transaction machinery lets one of the two writes
 *   proceed and fails the other with a write conflict, surfaced as a
 *   `TransientTransactionError`. The loser's whole transaction aborts -- nothing it wrote
 *   persists, including any earlier reservations it may have made against other batches.
 *
 *   `withTransaction` then retries the loser: a fresh session re-runs this function from its
 *   first read. This time the read sees the winner's committed Reserved_Quantity increase, so
 *   `take = min(remaining, availableQuantity(record))` is smaller (or the record has nothing
 *   left at all), and either the `hasAvailableAtLeastExpr(take)` filter fails to match on the
 *   very next attempt, or `remaining > 0` once every record has been scanned. Either path
 *   throws `INSUFFICIENT_AVAILABLE_QUANTITY`, and the loser's request is rejected with 409
 *   while the winner's Customer_Order commits (Req 7.5, 7.6, 7.7).
 *
 *   So of the two concurrently submitted requests, at most one ever sees its conditional
 *   update match while the sum of what both ask for exceeds availability, because the second
 *   one to actually apply its update is, by construction, evaluated against the state the
 *   first one already left behind -- never against a number read before either wrote
 *   anything.
 *
 * @param {{ item: string, location: string, quantity: number, orderId: import('mongoose').Types.ObjectId }} input
 * @param {import('mongoose').ClientSession} session the caller's transaction session
 * @returns {Promise<Array<{ item: string, location: string, batch: string, quantity: number }>>}
 *   the Reservation_Entry list; its quantities sum to `quantity` (Req 15.3, 15.6)
 * @throws {AppError} 409 INSUFFICIENT_AVAILABLE_QUANTITY when a conditional update misses, or
 *   when the location's total availability falls short of `quantity`
 */
async function reserveAcrossBatches({ item, location, quantity, orderId }, session) {
    const records = await InventoryRecord.find({ item, location })
        .sort({ batch: 1 }) // ascending batch order (Req 7.1)
        .session(session);

    let remaining = quantity;
    const entries = [];

    for (const record of records) {
        if (remaining === 0) break;

        // A candidate size only -- picking this does not reserve anything by itself.
        const take = Math.min(remaining, availableQuantity(record));
        if (take <= 0) continue;

        // The availability condition lives in the FILTER, evaluated by MongoDB at update
        // time against whatever the document currently holds, not in a JS comparison against
        // the `record` read above (Req 7.4).
        const result = await InventoryRecord.updateOne(
            {
                _id: record._id,
                ...hasAvailableAtLeastExpr(take),
            },
            { $inc: { reservedQuantity: take } },
            { session }
        );

        if (result.matchedCount !== 1) {
            // Availability disappeared between the read above and this update. The match
            // result IS the decision (Req 7.4) -- there is nothing left to double-check.
            throw insufficientAvailableQuantity();
        }

        // One ledger row per changed record, inside the same transaction as the update it
        // describes, the same discipline applyMovement enforces for every other mutation
        // path (Req 4.4, 8.1). Not routed through applyMovement itself: this update's guard
        // is reservedQuantity-only (Req 7.4), not applyMovement's combined physical+available
        // guard, so it is written directly here per design.md's own pattern.
        await InventoryTransaction.create(
            [
                {
                    inventoryRecord: record._id,
                    physicalDelta: 0,
                    reservedDelta: take,
                    movementReference: reserveMovementReference(orderId, record._id),
                    appliedAt: new Date(),
                },
            ],
            { session }
        );

        entries.push({ item, location, batch: record.batch, quantity: take });
        remaining -= take;
    }

    if (remaining > 0) {
        // Not enough total Available_Quantity across every batch at this location, even
        // though every individual update attempted above matched (Req 7.3).
        throw insufficientAvailableQuantity();
    }

    return entries; // sums to `quantity` (Req 15.3, 15.6)
}

/**
 * Creates a Customer_Order: reserves `quantity` units of `item` at `location` across
 * batches, then creates the order with Customer_Order_Status `Reserved` and the resulting
 * Reservation_Entry list, all inside one transaction (Req 7.1, 8.1).
 *
 * @param {{ customerName: string, item: string, location: string, quantity: number, createdBy: string }} input
 * @returns {Promise<import('mongoose').Document>} the created, populated CustomerOrder
 * @throws {AppError} 400 INVALID_REFERENCE when item or location does not exist; 409
 *   INSUFFICIENT_AVAILABLE_QUANTITY when the requested quantity cannot be fully reserved
 */
async function createOrder({ customerName, item, location, quantity, createdBy }) {
    const [itemExists, locationExists] = await Promise.all([
        Item.exists({ _id: item }),
        Location.exists({ _id: location }),
    ]);
    if (!itemExists || !locationExists) {
        throw invalidReference();
    }

    const orderId = await withTransaction(async (session) => {
        // Generated before the insert so reserveAcrossBatches can compose a movement
        // reference naming this order's id before the CustomerOrder document itself exists,
        // the same pre-generated-id pattern createInventoryRecord and receiveTransfer use for
        // their own opening/receipt ledger rows (Req 4.9 style consistency).
        const newOrderId = new mongoose.Types.ObjectId();

        const reservations = await reserveAcrossBatches(
            { item, location, quantity, orderId: newOrderId },
            session
        );

        await CustomerOrder.create(
            [
                {
                    _id: newOrderId,
                    customerName,
                    item,
                    location,
                    quantity,
                    status: 'Reserved',
                    reservations,
                    createdBy,
                },
            ],
            { session }
        );

        return newOrderId;
    });

    return populateOrder(CustomerOrder.findById(orderId));
}

/**
 * Lists CustomerOrders, optionally filtered by status, populated with enough of `item`
 * (including its `category`) and `location` for the API response shape (Req 3.2).
 *
 * @param {{ status?: string }} [filters]
 * @returns {Promise<import('mongoose').Document[]>}
 */
async function listOrders({ status } = {}) {
    const filter = {};
    if (status) filter.status = status;

    return populateOrder(CustomerOrder.find(filter));
}

/**
 * Reads one Customer_Order.
 *
 * @param {string} id
 * @returns {Promise<import('mongoose').Document>} the populated CustomerOrder
 * @throws {AppError} 404 NOT_FOUND when no Customer_Order matches `id`
 */
async function getOrder(id) {
    const order = await populateOrder(CustomerOrder.findById(id));
    if (!order) {
        throw notFound();
    }
    return order;
}

module.exports = {
    reserveAcrossBatches,
    createOrder,
    listOrders,
    getOrder,
};

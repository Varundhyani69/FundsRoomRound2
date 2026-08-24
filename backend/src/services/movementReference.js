// backend/src/services/movementReference.js -- the Movement_Reference builders: one
// function per business action that can move stock (Req 4.5, 4.6, 4.9).
//
// A Movement_Reference is the name of the business action behind a ledger row, not a random
// id. It is composed from the action type, the id of the document that caused it, and -- for
// the actions that have more than one step or touch more than one record -- the lifecycle
// step or the affected record id.
//
// These strings are the idempotency keys of the whole system. `InventoryTransaction`
// declares `movementReference` as a unique index, so replaying the same business action
// produces the same string a second time and the database rejects the insert with a
// duplicate-key error (code 11000). The services turn that error into
// `DUPLICATE_INVENTORY_TRANSACTION`, or into `TRANSFER_ALREADY_RECEIVED` on the receipt
// path, which is why no separate idempotency table exists (Req 4.5, 4.6, 6.9, 6.12, 6.16).
//
// The corollary is that two different actions must never compose the same string, and one
// action must always compose exactly the same string. That is why the composition lives
// here in one module rather than being inlined at each call site, and why the transfer step
// is validated below.

// The only two lifecycle steps of an Internal_Transfer that move stock. A dispatch takes
// units out of the source, a receipt puts them into the destination.
const TRANSFER_STEPS = Object.freeze(['DISPATCH', 'RECEIPT']);

/**
 * The opening ledger row written when an Inventory_Record is created.
 *
 * Uniqueness gives exactly one opening row per record: a record cannot be given a second
 * opening balance (Req 4.9).
 *
 * @param {string} recordId the new Inventory_Record id
 * @returns {string} e.g. `INVENTORY:6512...ab:OPENING`
 */
const openingMovementReference = (recordId) => `INVENTORY:${recordId}:OPENING`;

/**
 * A manual adjustment of one Inventory_Record.
 *
 * The client supplies its own reference in the request body, and it is scoped to the record
 * being adjusted. Uniqueness therefore rejects a replay of the same client reference against
 * the same record, while leaving the same client reference usable on a different record
 * (Req 4.6).
 *
 * @param {string} recordId the adjusted Inventory_Record id
 * @param {string} clientRef the `movementReference` from the request body
 * @returns {string} e.g. `ADJUST:6512...ab:stock-count-2024-05`
 */
const adjustMovementReference = (recordId, clientRef) => `ADJUST:${recordId}:${clientRef}`;

/**
 * One step of an Internal_Transfer.
 *
 * Uniqueness gives one dispatch and one receipt per transfer, which is what makes a second
 * receipt fail even when two receipts commit concurrently (Req 6.9, 6.12, 6.16).
 *
 * The step is checked against `TRANSFER_STEPS` rather than interpolated blindly: a typo such
 * as `'RECIEPT'` would otherwise compose a second, distinct reference that the unique index
 * happily accepts, silently allowing the same step twice. Failing here makes that a caller
 * bug rather than a data bug.
 *
 * @param {string} transferId the Internal_Transfer id
 * @param {'DISPATCH'|'RECEIPT'} step the lifecycle step being applied
 * @returns {string} e.g. `TRANSFER:6512...ab:DISPATCH`
 * @throws {Error} when `step` is not one of the two permitted values
 */
const transferMovementReference = (transferId, step) => {
    if (!TRANSFER_STEPS.includes(step)) {
        // Not an AppError: no request can reach this, so it is a programming mistake, not a
        // client mistake. It surfaces as an INTERNAL_ERROR through the error handler.
        throw new Error(
            `Unknown transfer movement step "${step}". Expected one of: ${TRANSFER_STEPS.join(', ')}.`
        );
    }

    return `TRANSFER:${transferId}:${step}`;
};

/**
 * One record's share of a Customer_Order reservation.
 *
 * A single order can reserve across several batches, so the reference carries the record id
 * as well as the order id: one row per record consumed, and a replay of the order is
 * rejected per record (Req 7.1).
 *
 * @param {string} orderId the Customer_Order id
 * @param {string} recordId the reserved Inventory_Record id
 * @returns {string} e.g. `ORDER:6512...ab:RESERVE:6512...cd`
 */
const reserveMovementReference = (orderId, recordId) =>
    `ORDER:${orderId}:RESERVE:${recordId}`;

module.exports = {
    openingMovementReference,
    adjustMovementReference,
    transferMovementReference,
    reserveMovementReference,
    TRANSFER_STEPS,
};

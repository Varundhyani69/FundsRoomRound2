// Movement reference builders: one function per business action that moves stock.
// These strings are the idempotency keys — the UNIQUE index on movement_reference rejects replays.

const TRANSFER_STEPS = Object.freeze(['DISPATCH', 'RECEIPT']);

/**
 * Opening ledger row reference for a new inventory record.
 * @param {string} recordId
 * @returns {string}
 */
const openingMovementReference = (recordId) => `INVENTORY:${recordId}:OPENING`;

/**
 * Manual adjustment reference, scoped to one record.
 * @param {string} recordId
 * @param {string} clientRef the client-supplied reference
 * @returns {string}
 */
const adjustMovementReference = (recordId, clientRef) => `ADJUST:${recordId}:${clientRef}`;

/**
 * Transfer dispatch or receipt reference.
 * @param {string} transferId
 * @param {'DISPATCH'|'RECEIPT'} step
 * @returns {string}
 */
const transferMovementReference = (transferId, step) => {
    if (!TRANSFER_STEPS.includes(step)) {
        throw new Error(
            `Unknown transfer movement step "${step}". Expected one of: ${TRANSFER_STEPS.join(', ')}.`
        );
    }

    return `TRANSFER:${transferId}:${step}`;
};

/**
 * Order reservation reference, scoped to both order and record.
 * @param {string} orderId
 * @param {string} recordId
 * @returns {string}
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

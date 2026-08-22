// backend/src/validation/inventory.schemas.js
// Request schemas for the inventory routes: creating a record, adjusting one,
// listing records, and reading Location_Available_Quantity. Every marker this
// file needs already exists in common.js; adding a schema here never touches
// validate.js (Req 9.1).

const { z } = require('zod');
const { objectId, validQuantity, batch } = require('./common');

// --- starting physical quantity (record creation only) ------------------------
// Req 3.10 lets a new Inventory_Record start at 0 units, up to 999,999,999 — the
// full Physical_Quantity range, not the movement range. Req 4.1's INVALID_QUANTITY
// (1 to 1,000,000) is scoped to "a request that changes Physical_Quantity or
// Reserved_Quantity", i.e. a movement against an EXISTING record; setting the
// opening balance of a brand new record is not a movement. Reusing validQuantity
// here would both reject the documented 0 case and mislabel an out-of-range
// starting value as INVALID_QUANTITY, so this is its own building block with no
// marker: an out-of-range value falls back to the plain VALIDATION_ERROR that
// Req 9.4 describes for an ordinary schema violation.
const STARTING_QUANTITY_MAX = 999_999_999;

const startingPhysicalQuantity = z.preprocess(
    (value) => (value === undefined ? undefined : Number(value)),
    z
        .number({
            required_error: 'is required',
            invalid_type_error: 'must be a whole number',
        })
        .int('must be a whole number')
        .min(0, 'must be at least 0')
        .max(STARTING_QUANTITY_MAX, `must be at most ${STARTING_QUANTITY_MAX.toLocaleString('en-US')}`)
);

// --- movement reference (create + adjust bodies) -------------------------------
// A non-empty string the client supplies so a retried write is idempotent (Req
// 4.5, 4.6, 4.8). No marker: an absent or blank value is an ordinary
// VALIDATION_ERROR, never INVALID_QUANTITY or INVALID_IDENTIFIER.
const MOVEMENT_REFERENCE_MAX = 200;

const movementReference = z
    .string({ required_error: 'is required', invalid_type_error: 'must be a string' })
    .trim()
    .min(1, 'must not be blank')
    .max(MOVEMENT_REFERENCE_MAX, `must be at most ${MOVEMENT_REFERENCE_MAX} characters`);

// --- movement direction (adjust body only) -------------------------------------
const DIRECTION_REASON = "must be 'IN' or 'OUT'";
const direction = z.enum(['IN', 'OUT'], {
    required_error: 'is required',
    invalid_type_error: DIRECTION_REASON,
    message: DIRECTION_REASON,
});

// --- request schemas ------------------------------------------------------------

/**
 * POST /api/inventory body. `physicalQuantity` is the opening balance
 * (Req 3.1, 3.10); `movementReference` names the opening ledger row's action
 * (Req 4.8).
 */
const createInventoryRecordBody = z
    .object({
        item: objectId,
        location: objectId,
        batch,
        physicalQuantity: startingPhysicalQuantity,
        movementReference,
    })
    .strict();

/** POST /api/inventory/:id/adjust path param. */
const adjustInventoryRecordParams = z.object({
    id: objectId,
});

/**
 * POST /api/inventory/:id/adjust body. `quantity` reuses common.js's
 * validQuantity, which already embeds the INVALID_QUANTITY marker (1 to
 * 1,000,000) matching Req 4.1 exactly, since this IS a movement against an
 * existing record.
 */
const adjustInventoryRecordBody = z
    .object({
        direction,
        quantity: validQuantity,
        movementReference,
    })
    .strict();

/** GET /api/inventory query: both filters optional. */
const listInventoryQuery = z.object({
    item: objectId.optional(),
    location: objectId.optional(),
});

/** GET /api/inventory/availability query: both filters required. */
const availabilityQuery = z.object({
    item: objectId,
    location: objectId,
});

module.exports = {
    createInventoryRecordBody,
    adjustInventoryRecordParams,
    adjustInventoryRecordBody,
    listInventoryQuery,
    availabilityQuery,
};

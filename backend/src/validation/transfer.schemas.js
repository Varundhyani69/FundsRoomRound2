// backend/src/validation/transfer.schemas.js
// Request schemas for the internal transfer routes: creating one, dispatching
// it, receiving it, reading its path param, and listing with an optional
// status filter. Reuses the shared building blocks from common.js so
// INVALID_IDENTIFIER and INVALID_QUANTITY markers behave exactly as they do
// for inventory and work orders (Req 9.1).

const { z } = require('zod');
const { objectId, batch, validQuantity } = require('./common');

const TRANSFER_STATUSES = ['Requested', 'Dispatched', 'Received'];

/**
 * POST /api/transfers body (Req 6.1, 6.13).
 * `quantity` reuses common.js's validQuantity, which already embeds the
 * INVALID_QUANTITY marker (1 to 1,000,000) matching Req 6.13 exactly.
 */
const createTransferBody = z
    .object({
        item: objectId,
        batch,
        sourceLocation: objectId,
        destinationLocation: objectId,
        quantity: validQuantity,
    })
    .strict();

/** POST /api/transfers/:id/dispatch and /:id/receive path param. */
const transferIdParams = z.object({
    id: objectId,
});

/**
 * POST /api/transfers/:id/dispatch body: no fields are accepted (Req 6.4).
 * `.strict()` on an empty shape still rejects any unexpected field.
 */
const dispatchTransferBody = z.object({}).strict();

/**
 * POST /api/transfers/:id/receive body: no fields are accepted (Req 6.7).
 * `.strict()` on an empty shape still rejects any unexpected field.
 */
const receiveTransferBody = z.object({}).strict();

/** GET /api/transfers query: status filter optional. */
const listTransfersQuery = z.object({
    status: z.enum(TRANSFER_STATUSES).optional(),
});

module.exports = {
    createTransferBody,
    transferIdParams,
    dispatchTransferBody,
    receiveTransferBody,
    listTransfersQuery,
};

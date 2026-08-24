// backend/src/validation/order.schemas.js
// Request schemas for the customer order routes: creating one, reading its
// path param, and listing with an optional status filter. Reuses the shared
// building blocks from common.js so INVALID_IDENTIFIER and INVALID_QUANTITY
// markers behave exactly as they do for inventory, work orders, and transfers
// (Req 9.1).

const { z } = require('zod');
const { identifier, validQuantity, customerName } = require('./common');

const ORDER_STATUSES = ['Reserved', 'Cancelled'];

/**
 * POST /api/orders body (Req 7.1, 7.9, 7.11).
 * `quantity` reuses common.js's validQuantity, which already embeds the
 * INVALID_QUANTITY marker (1 to 1,000,000) matching Req 7.9 exactly.
 * `customerName` reuses common.js's trimmed, 1..120 character rule (Req 7.11).
 */
const createOrderBody = z
    .object({
        customerName,
        item: identifier,
        location: identifier,
        quantity: validQuantity,
    })
    .strict();

/** GET /api/orders/:id path param (Req 9.10). */
const orderIdParams = z.object({
    id: identifier,
});

/** GET /api/orders query: status filter optional. */
const listOrdersQuery = z.object({
    status: z.enum(ORDER_STATUSES).optional(),
});

module.exports = {
    createOrderBody,
    orderIdParams,
    listOrdersQuery,
};

// backend/src/validation/workOrder.schemas.js
// Request schemas for the work order routes: creating one, changing its
// status, reading its path param, and listing with optional filters. Reuses
// the shared building blocks from common.js so INVALID_IDENTIFIER and
// INVALID_QUANTITY markers behave exactly as they do for inventory (Req 9.1).

const { z } = require('zod');
const { identifier, validQuantity } = require('./common');

const WORK_ORDER_STATUSES = ['Assigned', 'InProgress', 'Completed'];

/**
 * POST /api/work-orders body (Req 5.1, 5.2).
 * `requiredQuantity` reuses common.js's validQuantity, which already embeds
 * the INVALID_QUANTITY marker (1 to 1,000,000) matching Req 5.2 exactly.
 */
const createWorkOrderBody = z
    .object({
        location: identifier,
        item: identifier,
        requiredQuantity: validQuantity,
        assignedUser: identifier,
    })
    .strict();

/** GET/PATCH /api/work-orders/:id path param (Req 5.12). */
const workOrderIdParams = z.object({
    id: identifier,
});

/**
 * PATCH /api/work-orders/:id/status body (Req 5.11).
 * An out-of-enum value is a plain schema violation with no marker, so it
 * falls back to the ordinary VALIDATION_ERROR that validate.js reports for
 * any failure that isn't specifically flagged INVALID_QUANTITY or
 * INVALID_IDENTIFIER — no marker needed here.
 */
const changeWorkOrderStatusBody = z
    .object({
        status: z.enum(WORK_ORDER_STATUSES),
    })
    .strict();

/** GET /api/work-orders query: both filters optional. */
const listWorkOrdersQuery = z.object({
    status: z.enum(WORK_ORDER_STATUSES).optional(),
    location: identifier.optional(),
});

module.exports = {
    createWorkOrderBody,
    workOrderIdParams,
    changeWorkOrderStatusBody,
    listWorkOrdersQuery,
};

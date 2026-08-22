// backend/src/controllers/transfer.controller.js
// The internal transfer route handlers: list, create, dispatch, and receive. Like every
// controller, each handler reads only `req.validated` and `req.user` -- never raw
// `req.body` / `req.params` / `req.query` -- and holds no quantity or status comparison of
// its own; every guard and every write lives in src/services/transfer.service.js (Req 15.5).

const transferService = require('../services/transfer.service');

/**
 * Shapes one populated InternalTransfer document into the API response shape shared by
 * GET /api/transfers, POST /api/transfers, POST /api/transfers/:id/dispatch, and
 * POST /api/transfers/:id/receive (design.md's API surface table). Reused across all four so
 * the shape is declared once, the same pattern inventory.controller.js's
 * toInventoryRecordResponse and workOrder.controller.js's toWorkOrderResponse use.
 *
 * @param {import('mongoose').Document} transfer an InternalTransfer document populated with
 *   `item` (and `item.category`), `sourceLocation`, and `destinationLocation`
 */
function toTransferResponse(transfer) {
    return {
        id: String(transfer._id),
        item: {
            id: String(transfer.item._id),
            code: transfer.item.code,
            name: transfer.item.name,
            category: {
                id: String(transfer.item.category._id),
                name: transfer.item.category.name,
            },
        },
        batch: transfer.batch,
        sourceLocation: {
            id: String(transfer.sourceLocation._id),
            code: transfer.sourceLocation.code,
            name: transfer.sourceLocation.name,
        },
        destinationLocation: {
            id: String(transfer.destinationLocation._id),
            code: transfer.destinationLocation.code,
            name: transfer.destinationLocation.name,
        },
        quantity: transfer.quantity,
        receivedQuantity: transfer.receivedQuantity,
        status: transfer.status,
        createdAt: transfer.createdAt,
        dispatchedAt: transfer.dispatchedAt,
        receivedAt: transfer.receivedAt,
    };
}

/**
 * GET /api/transfers
 * 200 [{ id, item, batch, sourceLocation, destinationLocation, quantity, receivedQuantity,
 *        status, createdAt, dispatchedAt, receivedAt }]
 * 401 UNAUTHENTICATED
 */
async function listTransfers(req, res, next) {
    const { status } = req.validated.query;

    try {
        const transfers = await transferService.listTransfers({ status });
        return res.status(200).json(transfers.map(toTransferResponse));
    } catch (error) {
        // Express 4 does not observe a rejected promise, so the error is handed to
        // next() explicitly: errorHandler stays the only place that writes an
        // error response (Req 9.5).
        return next(error);
    }
}

/**
 * POST /api/transfers
 * 201 single object as above
 * 400 VALIDATION_ERROR / INVALID_QUANTITY / INVALID_REFERENCE / SAME_LOCATION_TRANSFER
 * 403 FORBIDDEN (raised by authorize() before this runs)
 */
async function createTransfer(req, res, next) {
    const { item, batch, sourceLocation, destinationLocation, quantity } = req.validated.body;

    try {
        const created = await transferService.createTransfer({
            item,
            batch,
            sourceLocation,
            destinationLocation,
            quantity,
        });
        return res.status(201).json(toTransferResponse(created));
    } catch (error) {
        return next(error);
    }
}

/**
 * POST /api/transfers/:id/dispatch
 * 200 single object as above
 * 400 INVALID_IDENTIFIER
 * 403 FORBIDDEN
 * 404 NOT_FOUND
 * 409 INVALID_STATUS_TRANSITION / INSUFFICIENT_AVAILABLE_QUANTITY
 */
async function dispatchTransfer(req, res, next) {
    const { id } = req.validated.params;

    try {
        const transfer = await transferService.dispatchTransfer(id);
        return res.status(200).json(toTransferResponse(transfer));
    } catch (error) {
        return next(error);
    }
}

/**
 * POST /api/transfers/:id/receive
 * 200 single object as above
 * 400 INVALID_IDENTIFIER
 * 403 FORBIDDEN
 * 404 NOT_FOUND
 * 409 INVALID_STATUS_TRANSITION / TRANSFER_ALREADY_RECEIVED
 */
async function receiveTransfer(req, res, next) {
    const { id } = req.validated.params;

    try {
        const transfer = await transferService.receiveTransfer(id);
        return res.status(200).json(toTransferResponse(transfer));
    } catch (error) {
        return next(error);
    }
}

module.exports = { listTransfers, createTransfer, dispatchTransfer, receiveTransfer };

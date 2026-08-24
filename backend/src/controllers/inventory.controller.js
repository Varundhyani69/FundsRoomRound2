// backend/src/controllers/inventory.controller.js
// The inventory route handlers: list, read Location_Available_Quantity, create a
// record, and adjust one. Like every controller, each handler reads only
// `req.validated` and `req.user` -- never raw `req.body` / `req.params` /
// `req.query` -- and holds no quantity comparison of its own; every guard and
// every write lives in src/services/inventory.service.js (Req 15.5).

const inventoryService = require('../services/inventory.service');

/**
 * GET /api/inventory
 * 200 [{ id, item, location, batch, physicalQuantity, reservedQuantity, availableQuantity }]
 * 400 INVALID_IDENTIFIER (raised by validate() before this runs)
 * 401 UNAUTHENTICATED
 */
async function listInventory(req, res, next) {
    const { item, location } = req.validated.query;

    try {
        const records = await inventoryService.listInventoryRecords({ item, location });
        return res.status(200).json(records);
    } catch (error) {
        // Express 4 does not observe a rejected promise, so the error is handed to
        // next() explicitly: errorHandler stays the only place that writes an
        // error response (Req 9.5).
        return next(error);
    }
}

/**
 * GET /api/inventory/availability
 * 200 { item, location, locationAvailableQuantity }
 * 400 VALIDATION_ERROR / INVALID_IDENTIFIER / INVALID_REFERENCE
 * 401 UNAUTHENTICATED
 */
async function getAvailability(req, res, next) {
    const { item, location } = req.validated.query;

    try {
        const result = await inventoryService.getLocationAvailability({ item, location });
        return res.status(200).json(result);
    } catch (error) {
        return next(error);
    }
}

/**
 * POST /api/inventory
 * 201 { id, item, location, batch, physicalQuantity, reservedQuantity, availableQuantity }
 * 400 VALIDATION_ERROR / INVALID_QUANTITY / INVALID_REFERENCE
 * 403 FORBIDDEN (raised by authorize() before this runs)
 * 409 DUPLICATE_INVENTORY_RECORD / DUPLICATE_INVENTORY_TRANSACTION
 */
async function createInventory(req, res, next) {
    // The service composes its own opening movementReference from the new
    // record's id (openingMovementReference), so the client-supplied value in
    // the body is validated (Req 4.8) but not forwarded here.
    const { item, location, batch, physicalQuantity } = req.validated.body;

    try {
        const record = await inventoryService.createInventoryRecord({
            item,
            location,
            batch,
            physicalQuantity,
            createdBy: req.user.id,
        });
        return res.status(201).json(record);
    } catch (error) {
        return next(error);
    }
}

/**
 * POST /api/inventory/:id/adjust
 * 200 { id, item, location, batch, physicalQuantity, reservedQuantity, availableQuantity }
 * 400 VALIDATION_ERROR / INVALID_QUANTITY / INVALID_IDENTIFIER
 * 403 FORBIDDEN
 * 404 NOT_FOUND
 * 409 INSUFFICIENT_PHYSICAL_QUANTITY / INSUFFICIENT_AVAILABLE_QUANTITY / DUPLICATE_INVENTORY_TRANSACTION
 */
async function adjustInventory(req, res, next) {
    const { id } = req.validated.params;
    const { direction, quantity, movementReference } = req.validated.body;

    try {
        const record = await inventoryService.adjustInventoryRecord({
            recordId: id,
            direction,
            quantity,
            movementReference,
            createdBy: req.user.id,
        });
        return res.status(200).json(record);
    } catch (error) {
        return next(error);
    }
}

module.exports = { listInventory, getAvailability, createInventory, adjustInventory };

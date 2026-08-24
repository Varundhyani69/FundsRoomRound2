// Inventory controller: list, availability, create, and adjust handlers.

const inventoryService = require('../services/inventory.service');

/** GET /api/inventory */
async function listInventory(req, res, next) {
    const { item, location } = req.validated.query;

    try {
        const records = await inventoryService.listInventoryRecords({ item, location });
        return res.status(200).json(records);
    } catch (error) {
        // Express 4 does not observe a rejected promise
        return next(error);
    }
}

/** GET /api/inventory/availability */
async function getAvailability(req, res, next) {
    const { item, location } = req.validated.query;

    try {
        const result = await inventoryService.getLocationAvailability({ item, location });
        return res.status(200).json(result);
    } catch (error) {
        return next(error);
    }
}

/** POST /api/inventory */
async function createInventory(req, res, next) {
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

/** POST /api/inventory/:id/adjust */
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

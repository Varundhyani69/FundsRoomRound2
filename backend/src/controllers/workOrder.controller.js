// backend/src/controllers/workOrder.controller.js
// The work order route handlers: list, read one, create, and change status. Like every
// controller, each handler reads only `req.validated` and `req.user` -- never raw
// `req.body` / `req.params` / `req.query` -- and holds no quantity or status comparison of
// its own; every guard and every write lives in src/services/workOrder.service.js (Req 15.5).

const workOrderService = require('../services/workOrder.service');

/**
 * GET /api/work-orders
 * 200 [{ id, location, item, requiredQuantity, assignedUser, status, statusChangedAt,
 *        locationAvailableQuantity, shortageQuantity, createdAt }]
 * 401 UNAUTHENTICATED
 */
async function listWorkOrders(req, res, next) {
    const { status, location } = req.validated.query;

    try {
        const workOrders = await workOrderService.listWorkOrders({ status, location });
        return res.status(200).json(workOrders);
    } catch (error) {
        // Express 4 does not observe a rejected promise, so the error is handed to
        // next() explicitly: errorHandler stays the only place that writes an
        // error response (Req 9.5).
        return next(error);
    }
}

/**
 * GET /api/work-orders/:id
 * 200 single object as above
 * 400 INVALID_IDENTIFIER
 * 404 NOT_FOUND
 */
async function getWorkOrder(req, res, next) {
    const { id } = req.validated.params;

    try {
        const workOrder = await workOrderService.getWorkOrder(id);
        return res.status(200).json(workOrder);
    } catch (error) {
        return next(error);
    }
}

/**
 * POST /api/work-orders
 * 201 single object as above
 * 400 VALIDATION_ERROR / INVALID_QUANTITY / INVALID_REFERENCE
 * 403 FORBIDDEN (raised by authorize() before this runs)
 */
async function createWorkOrder(req, res, next) {
    const { location, item, requiredQuantity, assignedUser } = req.validated.body;

    try {
        const created = await workOrderService.createWorkOrder({
            location,
            item,
            requiredQuantity,
            assignedUser,
            createdBy: req.user.id,
        });
        // createWorkOrder's own return value already carries shortage annotation via
        // getWorkOrder internally, so it is the full response shape.
        return res.status(201).json(created);
    } catch (error) {
        return next(error);
    }
}

/**
 * PATCH /api/work-orders/:id/status
 * 200 { id, status, statusChangedAt }
 * 400 VALIDATION_ERROR / INVALID_IDENTIFIER
 * 403 FORBIDDEN
 * 404 NOT_FOUND
 * 409 INVALID_STATUS_TRANSITION
 */
async function changeWorkOrderStatus(req, res, next) {
    const { id } = req.validated.params;
    const { status } = req.validated.body;

    try {
        const workOrder = await workOrderService.changeStatus({ id, targetStatus: status });
        return res.status(200).json({
            id: workOrder.id,
            status: workOrder.status,
            statusChangedAt: workOrder.statusChangedAt,
        });
    } catch (error) {
        return next(error);
    }
}

module.exports = { listWorkOrders, getWorkOrder, createWorkOrder, changeWorkOrderStatus };

// backend/src/controllers/workOrder.controller.js
// The work order route handlers: list, read one, create, and change status. Like every
// controller, each handler reads only `req.validated` and `req.user` -- never raw
// `req.body` / `req.params` / `req.query` -- and holds no quantity or status comparison of
// its own; every guard and every write lives in src/services/workOrder.service.js (Req 15.5).

const workOrderService = require('../services/workOrder.service');

/**
 * Shapes one populated, shortage-annotated WorkOrder document into the API response shape
 * shared by GET /api/work-orders, GET /api/work-orders/:id, and POST /api/work-orders
 * (design.md's API surface table). Reused across all three so the shape is declared once,
 * the same pattern inventory.controller.js's toInventoryRecordResponse uses.
 *
 * @param {import('mongoose').Document & { locationAvailableQuantity: number, shortageQuantity: number }} workOrder
 *   a WorkOrder document populated with `location`, `item` (and `item.category`), and
 *   `assignedUser`, and annotated with `locationAvailableQuantity` and `shortageQuantity`
 */
function toWorkOrderResponse(workOrder) {
    return {
        id: String(workOrder._id),
        location: {
            id: String(workOrder.location._id),
            code: workOrder.location.code,
            name: workOrder.location.name,
        },
        item: {
            id: String(workOrder.item._id),
            code: workOrder.item.code,
            name: workOrder.item.name,
            category: {
                id: String(workOrder.item.category._id),
                name: workOrder.item.category.name,
            },
        },
        requiredQuantity: workOrder.requiredQuantity,
        assignedUser: {
            id: String(workOrder.assignedUser._id),
            email: workOrder.assignedUser.email,
            role: workOrder.assignedUser.role,
        },
        status: workOrder.status,
        statusChangedAt: workOrder.statusChangedAt,
        locationAvailableQuantity: workOrder.locationAvailableQuantity,
        shortageQuantity: workOrder.shortageQuantity,
        createdAt: workOrder.createdAt,
    };
}

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
        return res.status(200).json(workOrders.map(toWorkOrderResponse));
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
        return res.status(200).json(toWorkOrderResponse(workOrder));
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
        // createWorkOrder's own return value carries no shortage annotation (only
        // listWorkOrders/getWorkOrder compute it); re-reading through getWorkOrder keeps
        // that derivation in the service (Req 15.5) while giving the response the same
        // shortage-annotated shape as the other three routes.
        const workOrder = await workOrderService.getWorkOrder(created._id);
        return res.status(201).json(toWorkOrderResponse(workOrder));
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
            id: String(workOrder._id),
            status: workOrder.status,
            statusChangedAt: workOrder.statusChangedAt,
        });
    } catch (error) {
        return next(error);
    }
}

module.exports = { listWorkOrders, getWorkOrder, createWorkOrder, changeWorkOrderStatus };

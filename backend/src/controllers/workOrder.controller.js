// Work order controller: list, read, create, and status-change handlers.

const workOrderService = require('../services/workOrder.service');

/** GET /api/work-orders */
async function listWorkOrders(req, res, next) {
    const { status, location } = req.validated.query;

    try {
        const workOrders = await workOrderService.listWorkOrders({ status, location });
        return res.status(200).json(workOrders);
    } catch (error) {
        // Express 4 does not observe a rejected promise
        return next(error);
    }
}

/** GET /api/work-orders/:id */
async function getWorkOrder(req, res, next) {
    const { id } = req.validated.params;

    try {
        const workOrder = await workOrderService.getWorkOrder(id);
        return res.status(200).json(workOrder);
    } catch (error) {
        return next(error);
    }
}

/** POST /api/work-orders */
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
        return res.status(201).json(created);
    } catch (error) {
        return next(error);
    }
}

/** PATCH /api/work-orders/:id/status */
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

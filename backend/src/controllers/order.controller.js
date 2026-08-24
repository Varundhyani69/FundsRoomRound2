// Order controller: list, read, and create handlers for customer orders.

const orderService = require('../services/order.service');

/** GET /api/orders */
async function listOrders(req, res, next) {
    const { status } = req.validated.query;

    try {
        const orders = await orderService.listOrders({ status });
        return res.status(200).json(orders);
    } catch (error) {
        // Express 4 does not observe a rejected promise
        return next(error);
    }
}

/** GET /api/orders/:id */
async function getOrder(req, res, next) {
    const { id } = req.validated.params;

    try {
        const order = await orderService.getOrder(id);
        return res.status(200).json(order);
    } catch (error) {
        return next(error);
    }
}

/** POST /api/orders */
async function createOrder(req, res, next) {
    const { customerName, item, location, quantity } = req.validated.body;

    try {
        const created = await orderService.createOrder({
            customerName,
            item,
            location,
            quantity,
            createdBy: req.user.id,
        });
        return res.status(201).json(created);
    } catch (error) {
        return next(error);
    }
}

module.exports = { listOrders, getOrder, createOrder };

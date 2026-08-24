// backend/src/controllers/order.controller.js
// The customer order route handlers: list, read one, and create. Like every
// controller, each handler reads only `req.validated` and `req.user` -- never raw
// `req.body` / `req.params` / `req.query` -- and holds no quantity or status comparison of
// its own; every guard and every write lives in src/services/order.service.js (Req 15.5).

const orderService = require('../services/order.service');

/**
 * GET /api/orders
 * 200 [{ id, customerName, item, location, quantity, status, reservations, createdAt }]
 * 401 UNAUTHENTICATED
 */
async function listOrders(req, res, next) {
    const { status } = req.validated.query;

    try {
        const orders = await orderService.listOrders({ status });
        return res.status(200).json(orders);
    } catch (error) {
        // Express 4 does not observe a rejected promise, so the error is handed to
        // next() explicitly: errorHandler stays the only place that writes an
        // error response (Req 9.5).
        return next(error);
    }
}

/**
 * GET /api/orders/:id
 * 200 single object as above
 * 400 INVALID_IDENTIFIER
 * 404 NOT_FOUND
 */
async function getOrder(req, res, next) {
    const { id } = req.validated.params;

    try {
        const order = await orderService.getOrder(id);
        return res.status(200).json(order);
    } catch (error) {
        return next(error);
    }
}

/**
 * POST /api/orders
 * 201 single object as above
 * 400 VALIDATION_ERROR / INVALID_QUANTITY / INVALID_REFERENCE
 * 403 FORBIDDEN (raised by authorize() before this runs)
 * 409 INSUFFICIENT_AVAILABLE_QUANTITY / CONCURRENT_MODIFICATION
 */
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

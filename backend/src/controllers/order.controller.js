// backend/src/controllers/order.controller.js
// The customer order route handlers: list, read one, and create. Like every
// controller, each handler reads only `req.validated` and `req.user` -- never raw
// `req.body` / `req.params` / `req.query` -- and holds no quantity or status comparison of
// its own; every guard and every write lives in src/services/order.service.js (Req 15.5).

const orderService = require('../services/order.service');

/**
 * Shapes one populated CustomerOrder document into the API response shape shared by
 * GET /api/orders, GET /api/orders/:id, and POST /api/orders (design.md's API surface
 * table). Reused across all three so the shape is declared once, the same pattern
 * inventory.controller.js's toInventoryRecordResponse, workOrder.controller.js's
 * toWorkOrderResponse, and transfer.controller.js's toTransferResponse use.
 *
 * `reservations` entries are left as the raw `item`/`location` ids order.service.js
 * stores them with -- they already name the order's own item and location, so
 * re-populating them here would only repeat information already on the parent object
 * (Req 15.3).
 *
 * @param {import('mongoose').Document} order a CustomerOrder document populated with
 *   `item` (and `item.category`) and `location`
 */
function toOrderResponse(order) {
    return {
        id: String(order._id),
        customerName: order.customerName,
        item: {
            id: String(order.item._id),
            code: order.item.code,
            name: order.item.name,
            category: {
                id: String(order.item.category._id),
                name: order.item.category.name,
            },
        },
        location: {
            id: String(order.location._id),
            code: order.location.code,
            name: order.location.name,
        },
        quantity: order.quantity,
        status: order.status,
        reservations: order.reservations.map((entry) => ({
            item: String(entry.item),
            location: String(entry.location),
            batch: entry.batch,
            quantity: entry.quantity,
        })),
        createdAt: order.createdAt,
    };
}

/**
 * GET /api/orders
 * 200 [{ id, customerName, item, location, quantity, status, reservations, createdAt }]
 * 401 UNAUTHENTICATED
 */
async function listOrders(req, res, next) {
    const { status } = req.validated.query;

    try {
        const orders = await orderService.listOrders({ status });
        return res.status(200).json(orders.map(toOrderResponse));
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
        return res.status(200).json(toOrderResponse(order));
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
        return res.status(201).json(toOrderResponse(created));
    } catch (error) {
        return next(error);
    }
}

module.exports = { listOrders, getOrder, createOrder };

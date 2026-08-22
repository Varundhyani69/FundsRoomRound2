// backend/src/routes/order.routes.js -- the three customer order routes.
//
// `authorize` is attached per route, not at the mount, because Express only fills in
// `req.route` once a route handler has matched (see middleware/authorize.js). The GET routes
// still get `authorize` so an unmapped Role token is refused before reaching the handler,
// even though every valid Role may read; the POST route is the write route `permissions.js`
// maps to Admin/SalesUser (Req 2.6, 2.7).

const express = require('express');

const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const { createOrderBody, orderIdParams, listOrdersQuery } = require('../validation/order.schemas');
const orderController = require('../controllers/order.controller');

const router = express.Router();

router.get('/', authorize, validate({ query: listOrdersQuery }), orderController.listOrders);

router.get(
    '/:id',
    authorize,
    validate({ params: orderIdParams }),
    orderController.getOrder
);

// Declared as '' rather than '/' so `req.route.path` is empty and
// `${req.baseUrl}${req.route.path}` builds `/api/orders` -- the exact key
// `permissions.js` declares, with no trailing slash.
router.post('', authorize, validate({ body: createOrderBody }), orderController.createOrder);

module.exports = router;

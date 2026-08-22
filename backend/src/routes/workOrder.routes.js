// backend/src/routes/workOrder.routes.js -- the four work order routes.
//
// `authorize` is attached per route, not at the mount, because Express only fills in
// `req.route` once a route handler has matched (see middleware/authorize.js). The two GET
// routes still get `authorize` so an unmapped Role token is refused before reaching the
// handler, even though every valid Role may read (Req 5.4's "any role"); the POST route and
// the PATCH status route are the write routes `permissions.js` maps to Admin, and to Admin /
// OperationsUser respectively (Req 2.2, 2.3, 2.14).

const express = require('express');

const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const {
    createWorkOrderBody,
    workOrderIdParams,
    changeWorkOrderStatusBody,
    listWorkOrdersQuery,
} = require('../validation/workOrder.schemas');
const workOrderController = require('../controllers/workOrder.controller');

const router = express.Router();

router.get(
    '/',
    authorize,
    validate({ query: listWorkOrdersQuery }),
    workOrderController.listWorkOrders
);

router.get(
    '/:id',
    authorize,
    validate({ params: workOrderIdParams }),
    workOrderController.getWorkOrder
);

// Declared as '' rather than '/' so `req.route.path` is empty and
// `${req.baseUrl}${req.route.path}` builds `/api/work-orders` -- the exact key
// `permissions.js` declares, with no trailing slash.
router.post(
    '',
    authorize,
    validate({ body: createWorkOrderBody }),
    workOrderController.createWorkOrder
);

router.patch(
    '/:id/status',
    authorize,
    validate({ params: workOrderIdParams, body: changeWorkOrderStatusBody }),
    workOrderController.changeWorkOrderStatus
);

module.exports = router;

// backend/src/routes/inventory.routes.js -- the four inventory routes.
//
// `authorize` is attached per route, not at the mount, because Express only
// fills in `req.route` once a route handler has matched (see
// middleware/authorize.js). The two GET routes still get `authorize` so an
// unmapped Role token is refused before reaching the handler, even though every
// valid Role may read (Req 2.13); the two POST routes are the write routes
// `permissions.js` maps to Admin/OperationsUser (Req 2.4, 2.5).
//
// GET /availability is declared before any parameterised GET path so a literal
// segment is never mistaken for an id. There is no GET /:id route in this
// design, so no ordering conflict exists today, but the availability route
// stays first regardless: correct today and inert protection if a GET /:id
// route is ever added later.

const express = require('express');

const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const {
    createInventoryRecordBody,
    adjustInventoryRecordParams,
    adjustInventoryRecordBody,
    listInventoryQuery,
    availabilityQuery,
} = require('../validation/inventory.schemas');
const inventoryController = require('../controllers/inventory.controller');

const router = express.Router();

router.get(
    '/availability',
    authorize,
    validate({ query: availabilityQuery }),
    inventoryController.getAvailability
);

router.get('/', authorize, validate({ query: listInventoryQuery }), inventoryController.listInventory);

// Declared as '' rather than '/' so `req.route.path` is empty and
// `${req.baseUrl}${req.route.path}` builds `/api/inventory` -- the exact key
// `permissions.js` declares, with no trailing slash.
router.post(
    '',
    authorize,
    validate({ body: createInventoryRecordBody }),
    inventoryController.createInventory
);

router.post(
    '/:id/adjust',
    authorize,
    validate({ params: adjustInventoryRecordParams, body: adjustInventoryRecordBody }),
    inventoryController.adjustInventory
);

module.exports = router;

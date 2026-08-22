// backend/src/routes/transfer.routes.js -- the four internal transfer routes.
//
// `authorize` is attached per route, not at the mount, because Express only fills in
// `req.route` once a route handler has matched (see middleware/authorize.js). The GET route
// still gets `authorize` so an unmapped Role token is refused before reaching the handler,
// even though every valid Role may read; the three POST routes are the write routes
// `permissions.js` maps to Admin/OperationsUser (Req 2.4, 2.5).

const express = require('express');

const authorize = require('../middleware/authorize');
const validate = require('../middleware/validate');
const {
    createTransferBody,
    transferIdParams,
    dispatchTransferBody,
    receiveTransferBody,
    listTransfersQuery,
} = require('../validation/transfer.schemas');
const transferController = require('../controllers/transfer.controller');

const router = express.Router();

router.get(
    '/',
    authorize,
    validate({ query: listTransfersQuery }),
    transferController.listTransfers
);

// Declared as '' rather than '/' so `req.route.path` is empty and
// `${req.baseUrl}${req.route.path}` builds `/api/transfers` -- the exact key
// `permissions.js` declares, with no trailing slash.
router.post(
    '',
    authorize,
    validate({ body: createTransferBody }),
    transferController.createTransfer
);

router.post(
    '/:id/dispatch',
    authorize,
    validate({ params: transferIdParams, body: dispatchTransferBody }),
    transferController.dispatchTransfer
);

router.post(
    '/:id/receive',
    authorize,
    validate({ params: transferIdParams, body: receiveTransferBody }),
    transferController.receiveTransfer
);

module.exports = router;

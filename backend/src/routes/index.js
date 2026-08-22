// backend/src/routes/index.js -- the /api router, mounted by app.js.
// Mount order is the security boundary: the public auth router first, then every
// later router with `authenticate` attached at its mount point, so no
// unauthenticated request can reach role evaluation (Req 1.8, 2.1).
// No route is declared before its increment, so an undeclared path keeps falling
// through to notFound and the documented route list stays exactly the implemented
// one (Req 13.9).

const express = require('express');

const authenticate = require('../middleware/authenticate');
const authRoutes = require('./auth.routes');
const referenceRoutes = require('./reference.routes');
const inventoryRoutes = require('./inventory.routes');

const router = express.Router();

// Public: the one route that runs without a token (Req 1.8).
router.use('/auth', authRoutes);

// Reference data for the Web_Client form dropdowns. Read-only, so any of the three
// Roles may call them, but each still needs a valid token (Req 2.13, 3.2).
router.use('/items', authenticate, referenceRoutes.items);
router.use('/locations', authenticate, referenceRoutes.locations);
router.use('/users', authenticate, referenceRoutes.users);

// Every protected router is mounted with `authenticate` in front of it, as
//     router.use('/inventory', authenticate, inventoryRoutes);
// rather than a bare `router.use(authenticate)` here. A catch-all would answer 401
// for any unmatched /api path too, and Req 9.12 wants those to reach notFound and
// return 404 ROUTE_NOT_FOUND. Attaching it per mount keeps both true.
router.use('/inventory', authenticate, inventoryRoutes);

// Routers for work orders, transfers and orders are added in their own
// increments.

module.exports = router;

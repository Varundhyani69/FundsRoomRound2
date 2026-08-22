// backend/src/routes/reference.routes.js -- the read-only reference lists.
//
// The three routes sit at three different top-level paths (/api/items,
// /api/locations, /api/users), so this file exports one small router per path
// instead of one router with three paths. That keeps the mount in routes/index.js
// on the established `router.use('/path', authenticate, someRoutes)` shape, which
// is what stops an unmatched /api path from being answered 401 instead of 404
// (Req 9.12).
//
// `authorize` is attached per route, not at the mount, because Express only fills
// in `req.route` once a route handler has matched. Every one of these routes is a
// GET, so authorize passes them for any of the three declared Roles and refuses a
// token carrying anything else (Req 2.12, 2.13). No entry in
// WRITE_ROUTE_PERMISSIONS is needed or wanted: none of these routes writes.

const express = require('express');

const authorize = require('../middleware/authorize');
const referenceController = require('../controllers/reference.controller');

const items = express.Router();
items.get('/', authorize, referenceController.listItems);

const locations = express.Router();
locations.get('/', authorize, referenceController.listLocations);

const users = express.Router();
users.get('/', authorize, referenceController.listUsers);

module.exports = { items, locations, users };

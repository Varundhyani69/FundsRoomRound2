// backend/tests/setup/authorizeTestApp.js -- a test-only Express app that mounts the
// REAL `authenticate`, the REAL `authorize` and the REAL `errorHandler` over stub route
// handlers.
//
// Why it exists: increment 3 declares no write route on the real app (those arrive in
// increments 5 to 8), so there is nothing to point a role x route matrix at yet. This app
// declares one stub route per entry in `WRITE_ROUTE_PERMISSIONS`, mounted so that the key
// authorize builds at run time -- `${req.method} ${req.baseUrl}${req.route.path}` -- is
// byte for byte the key the map declares. Same middleware, same keys, real HTTP; only the
// handler is a stub. It follows the pattern already used by tests/auth.test.js.
//
// `authorize` is attached PER ROUTE here, exactly as the real routers must attach it,
// because Express only populates `req.route` once a route has matched.

const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

const authenticate = require('../../src/middleware/authenticate');
const authorize = require('../../src/middleware/authorize');
const errorHandler = require('../../src/middleware/errorHandler');
const User = require('../../src/models/User');
const { WRITE_ROUTE_PERMISSIONS } = require('../../src/permissions');

// Every key in the map starts with this prefix, so one mount point reproduces every
// `req.baseUrl` the real routers will produce.
const API_PREFIX = '/api';

// A write route deliberately absent from `WRITE_ROUTE_PERMISSIONS`, for the
// deny-by-default check (Req 2.11).
const UNMAPPED_WRITE_ROUTE = 'POST /api/not-in-the-permission-map';

// A read route, for "reads pass for any valid role" (Req 2.13).
const READ_ROUTE = 'GET /api/read-only';

// Substituted for any `:param` segment when a test turns a map key into a request path.
const STUB_PARAM_ID = '000000000000000000000b01';

// What a stub write handler writes. A test asserts this value IS present after a
// permitted request and IS NOT present after a denied one, which is what gives
// "a denial modifies no document" its teeth.
const STUB_WRITE_MARKER = '000000000000000000000b02';

/**
 * The stub write handler: it modifies every seeded User, so a request that reaches it is
 * visible in the database, and then reports that it ran.
 */
async function stubWriteHandler(req, res, next) {
    try {
        await User.updateMany({}, { assignedLocation: STUB_WRITE_MARKER });
        res.status(200).json({ reached: true, role: req.user.role });
    } catch (error) {
        next(error);
    }
}

/** The stub read handler: writes nothing. */
function stubReadHandler(req, res) {
    res.status(200).json({ reached: true, role: req.user.role });
}

/**
 * Declare one stub route for a `"<METHOD> <mounted path>"` key on a router mounted at
 * `/api`, so `${req.baseUrl}${req.route.path}` rebuilds that same key.
 */
function mountStub(router, key, handler) {
    const [method, mountedPath] = key.split(' ');
    router[method.toLowerCase()](mountedPath.slice(API_PREFIX.length), authorize, handler);
}

const router = express.Router();

// One stub per declared write route, plus the unmapped write route and the read route.
Object.keys(WRITE_ROUTE_PERMISSIONS).forEach((key) => mountStub(router, key, stubWriteHandler));
mountStub(router, UNMAPPED_WRITE_ROUTE, stubWriteHandler);
mountStub(router, READ_ROUTE, stubReadHandler);

const app = express();
app.use(express.json());
// `authenticate` in front of the mount, as routes/index.js does it, so an unidentified
// request is answered 401 before any role is evaluated (Req 2.1).
app.use(API_PREFIX, authenticate, router);
app.use(errorHandler);

/**
 * Issue a request against a stub route.
 *
 * @param {string} key `"<METHOD> <mounted path>"`, e.g. `'POST /api/inventory'`
 * @param {string} [token] a JSON Web Token; omitted means no Authorization header
 * @returns {import('supertest').Test}
 */
function callRoute(key, token) {
    const [method, mountedPath] = key.split(' ');
    const path = mountedPath.replace(/:[^/]+/g, STUB_PARAM_ID);
    const pending = request(app)[method.toLowerCase()](path);
    return token === undefined ? pending : pending.set('Authorization', `Bearer ${token}`);
}

module.exports = {
    app,
    callRoute,
    UNMAPPED_WRITE_ROUTE,
    READ_ROUTE,
    STUB_PARAM_ID,
    STUB_WRITE_MARKER,
};

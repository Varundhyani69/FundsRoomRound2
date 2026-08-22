// backend/src/middleware/authorize.js -- the only reader of
// src/permissions.js, and the only place a Role is compared with a route.
//
// Attach it PER ROUTE, never app-wide or on a router mount:
//     router.post('/', authorize, validate(schema), controller)
// Express only populates `req.route` once a route handler has matched, so a
// mount-level `router.use(authorize)` would run before `req.route` exists and the
// map key would be wrong. Per-route attachment makes the key exact.
//
// It runs after `authenticate`, so a request carrying no valid token has already
// been rejected with 401 UNAUTHENTICATED and no Role is ever evaluated for it
// (Req 2.1).

const { ROLES, WRITE_ROUTE_PERMISSIONS } = require('../permissions');
const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

// The methods that can create, modify, or delete a document. Anything else is a
// read (Req 2.13).
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// One message for every denial -- unknown Role, unmapped write route, and a Role
// outside the permitted set all look the same to the client, and none of them
// reaches a route handler, so no document is created or modified
// (Req 2.3, 2.5, 2.7, 2.11, 2.12). Built fresh per call because AppError carries
// a per-request stack.
const forbidden = () =>
    new AppError(
        ERROR_CODES.FORBIDDEN,
        'FORBIDDEN',
        'Your role is not permitted for this operation.'
    );

function authorize(req, res, next) {
    const role = req.user && req.user.role;

    // Role enum check first: a token whose role is not one of the three declared
    // Roles is refused before any route lookup (Req 2.12).
    if (!ROLES.includes(role)) {
        return next(forbidden());
    }

    // Reads pass for any valid Role (Req 2.13).
    if (!WRITE_METHODS.has(req.method)) {
        return next();
    }

    // `${METHOD} ${mount prefix}${router-local path}` -- exactly the key shape
    // WRITE_ROUTE_PERMISSIONS declares. `req.route` is missing only when this
    // middleware was attached above the route layer, and the empty path that
    // leaves behind simply misses the map, so that mistake denies rather than
    // throws.
    const routePath = req.route ? req.route.path : '';
    const permitted = WRITE_ROUTE_PERMISSIONS[`${req.method} ${req.baseUrl}${routePath}`];

    // Deny by default: a write route with no entry in the map is refused
    // (Req 2.11).
    if (!permitted) {
        return next(forbidden());
    }

    // A mapped write route admits only the Roles it names (Req 2.3, 2.5, 2.7).
    if (!permitted.includes(role)) {
        return next(forbidden());
    }

    // Permitted: the request continues unchanged (Req 2.2, 2.4, 2.6).
    return next();
}

module.exports = authorize;

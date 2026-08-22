// backend/src/permissions.js -- the single place that says who may write what.
//
// Two exports and nothing else:
//   ROLES                    the closed Role set, also the User schema's enum
//   WRITE_ROUTE_PERMISSIONS  one entry per write route of the API surface
//
// Adding a Role means editing ROLES and the affected entries here; adding a write
// route means adding one entry here. No other module holds a role list or a
// per-route permission check (Req 2.8). src/middleware/authorize.js is the only
// reader of this map.

// The three Roles a token may carry. A request whose role is not in this list is
// rejected with 403 FORBIDDEN before any route lookup happens (Req 2.12).
const ROLES = ['Admin', 'OperationsUser', 'SalesUser'];

// key   = "<METHOD> <mounted path>", built at run time as
//         `${req.method} ${req.baseUrl}${req.route.path}` -- so the path here is
//         the mount prefix plus the router-local path, Express parameter names
//         included, exactly as the router declares it.
// value = every Role permitted to reach that route.
//
// Every write route of the design's API surface is listed, the Work_Order_Status
// change route included, so no write route depends on the deny-by-default branch
// of authorize() at run time (Req 2.14). Routes appear here before their
// increment declares them, which is harmless: an unmounted key is never looked
// up, and the alternative would be a window where a live write route has no
// entry. The route-completeness test in tests/authorization.test.js checks the
// other direction -- that every write route the app actually declares is named
// here (Req 2.8).
const WRITE_ROUTE_PERMISSIONS = {
    // Inventory: operations staff move stock, Admin may do anything (Req 2.4, 2.5).
    'POST /api/inventory': ['Admin', 'OperationsUser'],
    'POST /api/inventory/:id/adjust': ['Admin', 'OperationsUser'],

    // Work orders: only an Admin creates one (Req 2.2, 2.3), but the assigned
    // operations staff are the ones who advance its status (Req 2.14).
    'POST /api/work-orders': ['Admin'],
    'PATCH /api/work-orders/:id/status': ['Admin', 'OperationsUser'],

    // Internal transfers: the whole request/dispatch/receive lifecycle is
    // operations work (Req 2.4, 2.5).
    'POST /api/transfers': ['Admin', 'OperationsUser'],
    'POST /api/transfers/:id/dispatch': ['Admin', 'OperationsUser'],
    'POST /api/transfers/:id/receive': ['Admin', 'OperationsUser'],

    // Customer orders: sales reserve stock, Admin may too (Req 2.6, 2.7).
    'POST /api/orders': ['Admin', 'SalesUser'],
};

// Frozen so a stray assignment cannot widen a permitted Role set at run time.
// `Object.freeze` is shallow, so each Role array is frozen as well.
Object.values(WRITE_ROUTE_PERMISSIONS).forEach(Object.freeze);

module.exports = {
    ROLES: Object.freeze(ROLES),
    WRITE_ROUTE_PERMISSIONS: Object.freeze(WRITE_ROUTE_PERMISSIONS),
};

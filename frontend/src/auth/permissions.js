// frontend/src/auth/permissions.js -- a UI-only mirror of
// backend/src/permissions.js's WRITE_ROUTE_PERMISSIONS map.
//
// IMPORTANT: this is a convenience for hiding controls the backend would
// reject anyway (Req 2.9). It is NOT a security boundary. The backend's
// authorize middleware (backend/src/middleware/authorize.js) is the
// authoritative check -- it runs on every write request regardless of what
// this file says, and a user could still send a raw HTTP request around
// this map entirely. If the two maps ever drift apart, the backend wins;
// the worst this file can do wrong is show or hide a button incorrectly.
//
// Keep this map's keys and Role lists identical to the backend's
// WRITE_ROUTE_PERMISSIONS. There is no automated check tying the two
// together, so any change on the backend must be copied here by hand.

const WRITE_ROUTE_PERMISSIONS = {
    'POST /api/inventory': ['Admin', 'OperationsUser'],
    'POST /api/inventory/:id/adjust': ['Admin', 'OperationsUser'],

    'POST /api/work-orders': ['Admin'],
    'PATCH /api/work-orders/:id/status': ['Admin', 'OperationsUser'],

    'POST /api/transfers': ['Admin', 'OperationsUser'],
    'POST /api/transfers/:id/dispatch': ['Admin', 'OperationsUser'],
    'POST /api/transfers/:id/receive': ['Admin', 'OperationsUser'],

    'POST /api/orders': ['Admin', 'SalesUser'],
};

// Looks up the map the same way the backend's authorize middleware does:
// deny by default when the routeKey has no entry, or when role is not
// named in the permitted list for that entry.
export function canWrite(routeKey, role) {
    const permitted = WRITE_ROUTE_PERMISSIONS[routeKey];
    if (!permitted) return false;
    return permitted.includes(role);
}

// backend/src/errors/errorCodes.js
// The declared error code set as a `code -> httpStatus` object. This is the
// single source shared by the API documentation, so a doc/code mismatch is a
// direct comparison (Req 9.5, 13.9).

const ERROR_CODES = Object.freeze({
    // 400 - the request itself is wrong
    VALIDATION_ERROR: 400, // schema violation, unknown body field, blank or over-length string
    INVALID_QUANTITY: 400, // quantity not an integer in 1..1,000,000
    INVALID_REFERENCE: 400, // referenced item, location, user, or source record does not exist
    INVALID_IDENTIFIER: 400, // path or query id is not a 24-character hex string
    MALFORMED_JSON: 400, // JSON content type with an unparseable body
    SAME_LOCATION_TRANSFER: 400, // transfer source equals destination

    // 401 - the caller is not identified
    INVALID_CREDENTIALS: 401, // login email unmatched or password comparison failed
    UNAUTHENTICATED: 401, // token absent, undecodable, badly signed, or expired

    // 403 - the caller is identified but not permitted
    FORBIDDEN: 403, // role not permitted, unmapped write route, or unknown role

    // 404 - nothing matches
    NOT_FOUND: 404, // well-formed id matching no row
    ROUTE_NOT_FOUND: 404, // no declared route matches method and path

    // 409 - the request conflicts with current state
    DUPLICATE_INVENTORY_RECORD: 409, // item + location + batch already exists
    DUPLICATE_INVENTORY_TRANSACTION: 409, // movement reference already used
    INSUFFICIENT_PHYSICAL_QUANTITY: 409, // movement would drive physical below 0
    INSUFFICIENT_AVAILABLE_QUANTITY: 409, // movement would drive reserved above physical, or dispatch/reservation exceeds availability
    INVALID_STATUS_TRANSITION: 409, // target status is not the successor of the current status
    TRANSFER_ALREADY_RECEIVED: 409, // receipt against an already received transfer
    CONCURRENT_MODIFICATION: 409, // transient transaction error persisted after 3 retries

    // 500 - unexpected
    INTERNAL_ERROR: 500, // any error carrying no explicit status
});

// Exported as the bare table so `Object.keys(require('./errorCodes'))` is
// exactly the declared code set and nothing else.
module.exports = ERROR_CODES;

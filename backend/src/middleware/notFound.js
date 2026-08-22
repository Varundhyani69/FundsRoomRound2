// backend/src/middleware/notFound.js -- mounted after every route, before errorHandler.
// A method and path combination matching no declared route becomes a
// ROUTE_NOT_FOUND 404 (Req 9.12). It is forwarded to the error handler so the
// response envelope and the request log come from exactly one place.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

function notFound(req, res, next) {
    // The message names neither the requested path nor any module or file, so it
    // echoes nothing back to the caller (Req 9.7).
    next(
        new AppError(
            ERROR_CODES.ROUTE_NOT_FOUND,
            'ROUTE_NOT_FOUND',
            'No route matches the requested method and path.'
        )
    );
}

module.exports = notFound;

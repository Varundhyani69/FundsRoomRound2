// backend/src/middleware/errorHandler.js -- mounted LAST.
// The single place that turns an error into an HTTP response. The body is always
// { code, message } plus an optional details array, so no stack trace, file path,
// module name, or raw database text can reach a client (Req 9.5, 9.6, 9.7).

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

const MONGO_DUPLICATE_KEY = 11000;

/**
 * Sends the one permitted response shape and records the code for the request
 * log, which reads res.locals.errorCode on the response's finish event (Req 9.8).
 */
function send(res, code, message, details) {
    res.locals.errorCode = code;
    return res.status(ERROR_CODES[code]).json({
        code,
        message,
        ...(details ? { details } : {}),
    });
}

// eslint-disable-next-line no-unused-vars -- Express identifies an error handler by its four parameters
function errorHandler(error, req, res, next) {
    // Nothing can be changed once the response has started; let Express close it.
    if (res.headersSent) {
        return next(error);
    }

    // express.json() surfaces a SyntaxError carrying the raw body for an
    // unparseable JSON payload, and the route handler never ran (Req 9.11).
    if (error instanceof SyntaxError && 'body' in error) {
        return send(res, 'MALFORMED_JSON', 'Request body is not valid JSON.');
    }

    // Every deliberate rejection arrives as an AppError, which carries the
    // status and the stable code decided where the rule lives (Req 9.5).
    if (error instanceof AppError) {
        res.locals.errorCode = error.code;
        return res.status(error.status).json({
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
        });
    }

    // Safety net for a unique-index violation that no service translated.
    if (error && error.code === MONGO_DUPLICATE_KEY) {
        return send(
            res,
            'DUPLICATE_INVENTORY_TRANSACTION',
            'This movement has already been applied.'
        );
    }

    // Full detail to the server log, a generic message to the client (Req 9.6, 9.7).
    console.error('[unhandled]', error);
    return send(res, 'INTERNAL_ERROR', 'Something went wrong.');
}

module.exports = errorHandler;

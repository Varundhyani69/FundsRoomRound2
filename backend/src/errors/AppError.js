// backend/src/errors/AppError.js
// One error class carries an HTTP status and a stable code.
// Nothing else in the codebase decides an HTTP status (Req 9.5).

/**
 * @param {number} status  HTTP status sent to the client
 * @param {string} code    stable code from errorCodes.js
 * @param {string} message human-readable, safe to return to the client
 * @param {{ details?: Array<{ field: string, reason: string }>, cause?: unknown }} [options]
 */
class AppError extends Error {
    constructor(status, code, message, options = {}) {
        super(message);
        this.name = 'AppError';

        this.status = status; // HTTP status
        this.code = code; // stable code from errorCodes.js
        this.details = options.details || undefined; // [{ field, reason }] for VALIDATION_ERROR

        // The underlying error, kept for the server log only. Non-enumerable so it
        // cannot reach a response body through any serialization (Req 9.7).
        Object.defineProperty(this, 'cause', {
            value: options.cause,
            enumerable: false,
            writable: true,
            configurable: true,
        });

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }
}

module.exports = AppError;

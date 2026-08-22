// backend/src/middleware/validate.js
// The one middleware that validates a request before its handler runs. It checks
// path parameters, the query string, and the body against declared schemas,
// attaches the parsed result as req.validated, and turns any failure into an
// AppError so the error handler stays the only place that writes a response
// (Req 9.1, 9.2, 9.3, 9.4, 9.10).

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { readMarker } = require('../validation/common');

// Checked in this order so a malformed path id is reported before body contents.
const PARTS = ['params', 'query', 'body'];

// The message that accompanies each code a schema can ask for. A code with no
// entry here is not one this layer may raise, so it falls back to
// VALIDATION_ERROR rather than inventing a message.
const MESSAGES = Object.freeze({
    VALIDATION_ERROR: 'Request validation failed.',
    INVALID_IDENTIFIER:
        'A supplied identifier is not a 24-character hexadecimal string.',
    INVALID_QUANTITY: 'Quantity must be a whole number from 1 to 1,000,000.',
});

/**
 * @param {{ params?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, body?: import('zod').ZodTypeAny }} schemas
 * @returns {import('express').RequestHandler}
 */
function validate(schemas = {}) {
    return (req, res, next) => {
        const validated = {};

        for (const part of PARTS) {
            const schema = schemas[part];
            if (!schema) continue;

            const parsed = schema.safeParse(req[part]);
            if (!parsed.success) {
                return next(validationError(part, parsed.error));
            }
            validated[part] = parsed.data;
        }

        // Controllers read ONLY this: coerced, trimmed, and schema-approved
        // values, never raw req.body / req.params / req.query (Req 9.3).
        req.validated = validated;
        return next();
    };
}

/**
 * Turns a zod error into the AppError for this rejection: one details entry per
 * rejected field, and the most specific error code the failing fields agree on.
 * @param {string} part 'params' | 'query' | 'body'
 * @param {import('zod').ZodError} error
 */
function validationError(part, error) {
    const details = [];
    const namedFields = new Set();
    const requestedCodes = new Set();

    for (const issue of error.issues) {
        for (const entry of expand(part, issue)) {
            requestedCodes.add(entry.code);

            // Req 9.4 asks for one entry per rejected field. A single field can
            // fail several checks (blank and over-length, say), so the first
            // reason for a field wins and later ones are dropped.
            if (namedFields.has(entry.field)) continue;
            namedFields.add(entry.field);
            details.push({ field: entry.field, reason: entry.reason });
        }
    }

    const code = resolveCode(requestedCodes);
    return new AppError(ERROR_CODES[code], code, MESSAGES[code], { details });
}

/**
 * One zod issue becomes one or more { field, reason, code } entries.
 * @param {string} part
 * @param {import('zod').ZodIssue} issue
 */
function expand(part, issue) {
    // .strict() reports every undeclared key of an object in a single issue whose
    // path is the object itself. Req 9.2 and 9.4 want the rejected field named,
    // so the keys are split back out into one entry each.
    if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => ({
            field: fieldName(part, [...issue.path, key]),
            reason: 'is not an allowed field',
            code: 'VALIDATION_ERROR',
        }));
    }

    const { code, reason } = readMarker(issue.message);
    return [
        {
            field: fieldName(part, issue.path),
            reason,
            code: code || 'VALIDATION_ERROR',
        },
    ];
}

/**
 * The dotted path of the rejected field. An issue on the part as a whole (a body
 * that is not an object, for instance) has an empty path, so the part is named
 * instead of returning a blank field.
 */
function fieldName(part, path) {
    return path.length > 0 ? path.join('.') : part;
}

/**
 * Picks the response code. A specific code is used only when every rejected
 * field asked for that same code, so a malformed id alone is INVALID_IDENTIFIER
 * and a bad quantity alone is INVALID_QUANTITY, while mixed failures fall back
 * to VALIDATION_ERROR (Req 9.4, 9.10, and Req 4.1 once quantity schemas exist).
 */
function resolveCode(requestedCodes) {
    if (requestedCodes.size !== 1) return 'VALIDATION_ERROR';

    const [code] = requestedCodes;
    const known = Object.prototype.hasOwnProperty.call(MESSAGES, code) &&
        Object.prototype.hasOwnProperty.call(ERROR_CODES, code);

    return known ? code : 'VALIDATION_ERROR';
}

module.exports = validate;
module.exports.MESSAGES = MESSAGES;

// backend/src/validation/common.js
// The shared schema building blocks. Every rule that more than one route needs
// lives here exactly once, so a change to what a valid id, quantity, batch, or
// customer name is happens in a single place (Req 9.1).

const { z } = require('zod');

// --- error-code markers -------------------------------------------------------
// A zod issue carries a path and a message but never says which schema produced
// it, so a shared building block has no other way to ask for a specific error
// code. The code travels inside the issue message between two markers:
// validate.js reads it, picks the response code, and strips the marker before
// the reason reaches the client. Giving a new building block its own code is one
// reasonFor() call here and no change at all to validate.js.
const MARKER = /^\[\[([A-Z_]+)\]\]/;

/**
 * Builds an issue message that asks for a specific error code.
 * @param {string} code stable code from errors/errorCodes.js
 * @param {string} reason human-readable reason, the part a client sees
 */
function reasonFor(code, reason) {
    return `[[${code}]]${reason}`;
}

/**
 * Splits an issue message back into its requested code and its reason.
 * @param {string} message
 * @returns {{ code: string | null, reason: string }} code is null when the
 *          message carries no marker, which means "no specific code requested".
 */
function readMarker(message) {
    const match = MARKER.exec(message);
    if (!match) {
        return { code: null, reason: message };
    }
    return { code: match[1], reason: message.slice(match[0].length) };
}

// --- building blocks ----------------------------------------------------------

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const OBJECT_ID_REASON = reasonFor(
    'INVALID_IDENTIFIER',
    'must be a 24-character hexadecimal identifier'
);

/**
 * A document identifier: a 24-character hexadecimal string (Req 9.10).
 * A malformed value is reported as INVALID_IDENTIFIER; an omitted one stays a
 * plain presence failure, so a missing field is still a VALIDATION_ERROR.
 */
const objectId = z
    .string({
        required_error: 'is required',
        invalid_type_error: OBJECT_ID_REASON,
    })
    .regex(OBJECT_ID_PATTERN, OBJECT_ID_REASON);

const QUANTITY_MAX = 1_000_000;
const QUANTITY_REASON = reasonFor(
    'INVALID_QUANTITY',
    `must be a whole number from 1 to ${QUANTITY_MAX.toLocaleString('en-US')}`
);

/**
 * Valid_Quantity: an integer from 1 to 1,000,000 (Req 4.1).
 * z.coerce.number() would turn an omitted value into NaN and report it as an
 * invalid quantity, but Req 4.8 wants an omitted quantity reported as a missing
 * field, so undefined passes through untouched and everything else is coerced
 * (Req 9.3).
 */
const validQuantity = z.preprocess(
    (value) => (value === undefined ? undefined : Number(value)),
    z
        .number({
            required_error: 'is required',
            invalid_type_error: QUANTITY_REASON,
        })
        .int(QUANTITY_REASON)
        .min(1, QUANTITY_REASON)
        .max(QUANTITY_MAX, QUANTITY_REASON)
);

/** Batch label: trimmed, non-blank, at most 32 characters (Req 3.1, 3.6). */
const batch = z
    .string({ required_error: 'is required', invalid_type_error: 'must be a string' })
    .trim()
    .min(1, 'must not be blank')
    .max(32, 'must be at most 32 characters');

/** Customer name: trimmed, non-blank, at most 120 characters (Req 7.11). */
const customerName = z
    .string({ required_error: 'is required', invalid_type_error: 'must be a string' })
    .trim()
    .min(1, 'must not be blank')
    .max(120, 'must be at most 120 characters');

module.exports = {
    objectId,
    validQuantity,
    batch,
    customerName,
    reasonFor,
    readMarker,
    OBJECT_ID_PATTERN,
    QUANTITY_MAX,
};

// backend/src/validation/auth.schemas.js
// The login request schema. Every rejection here is a VALIDATION_ERROR 400 raised
// before the login handler runs, so no token can be issued for a malformed
// request (Req 1.11).

const { z } = require('zod');

// bcrypt only considers the first 72 bytes of a password, so a longer value is
// rejected rather than silently truncated (Req 1.11).
const PASSWORD_MAX = 72;
const EMAIL_MAX = 254;

const loginBody = z
    .object({
        // Trimmed and lowercased here, so the service compares exactly what the
        // User model stores (Req 1.1, 9.3).
        email: z
            .string({
                required_error: 'is required',
                invalid_type_error: 'must be a string',
            })
            .trim()
            .toLowerCase()
            .min(1, 'must not be blank')
            .max(EMAIL_MAX, `must be at most ${EMAIL_MAX} characters`),
        password: z
            .string({
                required_error: 'is required',
                invalid_type_error: 'must be a string',
            })
            .trim()
            .min(1, 'must not be blank')
            .max(PASSWORD_MAX, `must be at most ${PASSWORD_MAX} characters`),
    })
    // Rejects any field the schema does not name, so nothing undeclared reaches
    // the handler (Req 9.2).
    .strict();

module.exports = { loginBody, EMAIL_MAX, PASSWORD_MAX };

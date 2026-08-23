// backend/src/services/auth.service.js -- the Auth_Service: it hashes passwords and it
// turns an email/password pair into a signed token plus the caller's identity
// (Req 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.10).
//
// This module owns password hashing and token issuance only. Token verification lives in
// src/middleware/authenticate.js, which calls `jsonwebtoken.verify` against the same
// `config.jwtSecret`, so there is no dependency between the two.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { query } = require('../db/pool');
const AppError = require('../errors/AppError');

// Cost factor 10, inside the required 10..12 band (Req 1.5).
const BCRYPT_COST = 10;

// Exactly 8 hours after the issuance instant (Req 1.6).
const TOKEN_TTL = '8h';

// One message for both login failure modes. An unmatched email and a failed password
// comparison return an identical status, code, and message, so a client cannot use the
// response to learn which email addresses exist (Req 1.4, 1.10).
const INVALID_CREDENTIALS_MESSAGE = 'Email or password is incorrect.';

// A pre-computed hash of a value no account uses. When no User matches, the comparison is
// still run against this so a missing email and a wrong password take the same amount of
// work, which stops email existence being probed through response timing (Req 1.4).
const DUMMY_PASSWORD_HASH =
    '$2a$10$7F7jd2PTiMf9u1ga5/CDnuMxjj6POdqbbq6H8AevqyhhH3/wmxrdG';

const invalidCredentials = () =>
    new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);

/**
 * Hash a plaintext password for storage. The single place a plaintext value becomes the
 * `passwordHash` persisted on a User, used by the seed script (Req 1.5).
 *
 * @param {string} plain
 * @returns {Promise<string>} bcrypt hash at cost factor 10
 */
function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Authenticate a User and issue an access token.
 *
 * The email is normalized the same way the schema stores it (trim + lowercase), so the
 * lookup compares like with like (Req 1.1, 1.2). Neither branch writes to any document.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ token: string, user: { id: string, email: string, role: string, assignedLocation: string|null } }>}
 * @throws {AppError} 401 INVALID_CREDENTIALS for an unmatched email or a failed comparison
 */
async function login(email, password) {
    const normalizedEmail = String(email).trim().toLowerCase();

    // password_hash is named explicitly here. It is the ONLY query in the codebase that
    // selects it -- every other read of `users` lists id, email and role -- so the hash
    // cannot leak into a response by accident (Req 1.1).
    const rows = await query(
        `SELECT id, email, password_hash, role, assigned_location_id
           FROM users WHERE email = ?`,
        [normalizedEmail]
    );

    if (rows.length === 0) {
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
        throw invalidCredentials(); // Req 1.2
    }

    const user = rows[0];

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
        throw invalidCredentials(); // Req 1.3 -- identical to the branch above (Req 1.4)
    }

    // `sub` is the User identifier and `role` is the Role; the middleware reads exactly
    // these two claims back out (Req 1.6, 1.7).
    const token = jwt.sign(
        { sub: user.id, role: user.role },
        config.jwtSecret,
        { expiresIn: TOKEN_TTL }
    );

    // Built field by field rather than by spreading the row, so the hash cannot reach the
    // response body (Req 1.1).
    return {
        token,
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            assignedLocation: user.assigned_location_id || null,
        },
    };
}

module.exports = {
    login,
    hashPassword,
    BCRYPT_COST,
    TOKEN_TTL,
    INVALID_CREDENTIALS_MESSAGE,
};

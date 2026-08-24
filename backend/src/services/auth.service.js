// Auth service: password hashing and token issuance.
// Timing-safe login — a missing email still runs bcrypt against a dummy hash.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { query } = require('../db/pool');
const AppError = require('../errors/AppError');

const BCRYPT_COST = 10;
const TOKEN_TTL = '8h';
const INVALID_CREDENTIALS_MESSAGE = 'Email or password is incorrect.';

// Dummy hash so a missing-email path takes the same time as a wrong-password path.
const DUMMY_PASSWORD_HASH =
    '$2a$10$7F7jd2PTiMf9u1ga5/CDnuMxjj6POdqbbq6H8AevqyhhH3/wmxrdG';

const invalidCredentials = () =>
    new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);

/** Hash a plaintext password for storage. */
function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Authenticate a user and issue an access token.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ token: string, user: { id: string, email: string, role: string, assignedLocation: string|null } }>}
 */
async function login(email, password) {
    const normalizedEmail = String(email).trim().toLowerCase();

    const rows = await query(
        `SELECT id, email, password_hash, role, assigned_location_id
           FROM users WHERE email = ?`,
        [normalizedEmail]
    );

    if (rows.length === 0) {
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
        throw invalidCredentials();
    }

    const user = rows[0];

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
        throw invalidCredentials();
    }

    const token = jwt.sign(
        { sub: user.id, role: user.role },
        config.jwtSecret,
        { expiresIn: TOKEN_TTL }
    );

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

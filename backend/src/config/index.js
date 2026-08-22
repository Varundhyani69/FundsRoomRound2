// backend/src/config/index.js -- the only module that touches process.env (Req 10.4)
require('dotenv').config();

// Exactly four required variables, read before the database connection is opened
// and before the port is bound (Req 10.1). No defaults are applied (Req 10.3),
// and no decision depends on host name, file path, or OS value (Req 10.5).
const REQUIRED = ['MONGODB_URI', 'JWT_SECRET', 'PORT', 'CORS_ORIGIN'];

const MIN_JWT_SECRET_LENGTH = 32;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Pure loader: reads an env object, never exits, never logs.
 * @param {Record<string, string|undefined>} env
 * @returns {{ok: true, config: object} | {ok: false, errors: string[]}}
 */
function loadConfig(env = process.env) {
    const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

    // Absent, empty, or whitespace-only required variables are reported together
    // in a single message naming every one of them (Req 10.2).
    const missing = REQUIRED.filter((name) => isBlank(env[name]));
    if (missing.length > 0) {
        return {
            ok: false,
            errors: [`Missing required environment variables: ${missing.join(', ')}`],
        };
    }

    const errors = [];

    // PORT must be a decimal integer in 1..65535 (Req 10.9).
    const portValue = env.PORT;
    const port = /^\d+$/.test(portValue) ? Number(portValue) : Number.NaN;
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
        errors.push(
            `PORT must be a decimal integer between ${MIN_PORT} and ${MAX_PORT}`
        );
    }

    // JWT_SECRET must be at least 32 characters (Req 10.10).
    if (env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
        errors.push(
            `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`
        );
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        config: {
            mongoUri: env.MONGODB_URI,
            jwtSecret: env.JWT_SECRET,
            port,
            corsOrigin: env.CORS_ORIGIN,
        },
    };
}

/**
 * Startup wrapper: writes every error to standard error as one message and
 * exits non-zero before the database connection is opened and before the port
 * is bound (Req 10.2, 10.9, 10.10).
 */
function loadOrExit(env = process.env) {
    const result = loadConfig(env);
    if (!result.ok) {
        console.error(result.errors.join('\n'));
        process.exit(1);
        return undefined; // unreachable in production; keeps the contract explicit
    }
    return result.config;
}

// The rest of the API server consumes this resolved object, so no other module
// reads process.env (Req 10.4). Evaluated before connect() and before listen().
const config = loadOrExit(process.env);

// Helpers are attached non-enumerably so the config object still serialises as
// exactly the four resolved values.
Object.defineProperties(config, {
    loadConfig: { value: loadConfig, enumerable: false },
    loadOrExit: { value: loadOrExit, enumerable: false },
    REQUIRED: { value: Object.freeze([...REQUIRED]), enumerable: false },
});

module.exports = config;

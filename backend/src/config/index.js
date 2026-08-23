// backend/src/config/index.js -- the only module that touches process.env (Req 10.4)
require('dotenv').config();

// The required variables, read before the database connection is opened and before
// the port is bound (Req 10.1). No defaults are applied (Req 10.3), and no decision
// depends on host name, file path, or OS value (Req 10.5).
//
// The four MYSQL_* names replace the single MONGODB_URI this project used before
// migrating to MySQL. They are kept as separate variables rather than one
// connection URL because that is the shape every managed MySQL host hands you --
// AWS RDS shows an endpoint, a port, a user and a database name on separate
// fields, so a deployment copies them across without having to assemble a URL.
const REQUIRED = [
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_USER',
    'MYSQL_DATABASE',
    'JWT_SECRET',
    'PORT',
    'CORS_ORIGIN',
];

// MYSQL_PASSWORD is required to be PRESENT but is allowed to be empty: a local
// MySQL install with a passwordless root user is a legitimate development setup,
// while a silently-absent password would be a typo worth catching.
const REQUIRED_ALLOWING_EMPTY = ['MYSQL_PASSWORD'];

// Every required name in declaration order, so a "missing variables" message lists
// them in a stable, predictable order and `config.REQUIRED` is the complete set.
const ALL_REQUIRED = [...REQUIRED, ...REQUIRED_ALLOWING_EMPTY];

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
    // in a single message naming every one of them (Req 10.2). The
    // password-shaped variable is checked only for presence, since an empty
    // password is a valid local setup.
    const missing = [
        ...REQUIRED.filter((name) => isBlank(env[name])),
        ...REQUIRED_ALLOWING_EMPTY.filter((name) => typeof env[name] !== 'string'),
    ].sort((a, b) => ALL_REQUIRED.indexOf(a) - ALL_REQUIRED.indexOf(b));

    if (missing.length > 0) {
        return {
            ok: false,
            errors: [`Missing required environment variables: ${missing.join(', ')}`],
        };
    }

    const errors = [];

    // MYSQL_PORT must be a decimal integer in 1..65535, the same rule as PORT:
    // a database port typo should fail at startup, not on the first query.
    const mysqlPortValue = env.MYSQL_PORT;
    const mysqlPort = /^\d+$/.test(mysqlPortValue) ? Number(mysqlPortValue) : Number.NaN;
    if (!Number.isInteger(mysqlPort) || mysqlPort < MIN_PORT || mysqlPort > MAX_PORT) {
        errors.push(
            `MYSQL_PORT must be a decimal integer between ${MIN_PORT} and ${MAX_PORT}`
        );
    }

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

    // MYSQL_SSL is OPTIONAL, and the only optional variable this loader reads. It
    // stays out of the required set on purpose: a local MySQL server speaks plain
    // TCP, so demanding it would break the default development setup and the test
    // harness. Every managed host (Aiven, PlanetScale, RDS with TLS enforced)
    // requires TLS, which is what this exists for.
    //
    // Read here rather than in db/pool.js because this module is the only one
    // permitted to touch process.env (Req 10.4), and tests/config.test.js asserts
    // exactly that.
    //
    // Two accepted values, and the difference matters:
    //   MYSQL_SSL=true            verify the server certificate (use this)
    //   MYSQL_SSL=no-verify       encrypt but do NOT verify the certificate
    // `no-verify` still encrypts the connection but accepts any certificate, so it
    // gives no protection against an active man-in-the-middle. It exists only for a
    // host that presents a self-signed certificate and offers no CA bundle; treat
    // needing it as a problem to fix rather than a setting to keep.
    const mysqlSslValue = typeof env.MYSQL_SSL === 'string' ? env.MYSQL_SSL.trim() : '';
    let mysqlSsl = null;
    if (mysqlSslValue === 'true') {
        mysqlSsl = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
    } else if (mysqlSslValue === 'no-verify') {
        mysqlSsl = { minVersion: 'TLSv1.2', rejectUnauthorized: false };
    } else if (mysqlSslValue !== '') {
        errors.push("MYSQL_SSL, when set, must be either 'true' or 'no-verify'");
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        config: {
            // Grouped under one `mysql` object so a caller passes `config.mysql`
            // straight to mysql2's createPool without restating field names.
            mysql: {
                host: env.MYSQL_HOST,
                port: mysqlPort,
                user: env.MYSQL_USER,
                password: env.MYSQL_PASSWORD,
                database: env.MYSQL_DATABASE,
                // Only present when MYSQL_SSL is set, because mysql2 treats the
                // `ssl` key as "use TLS" by its mere presence -- an explicit
                // `ssl: undefined` would be read as a request for TLS with default
                // options and break a plain local connection.
                ...(mysqlSsl ? { ssl: mysqlSsl } : {}),
            },
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
    REQUIRED: { value: Object.freeze([...ALL_REQUIRED]), enumerable: false },
});

module.exports = config;

// backend/src/db/pool.js -- the one mysql2 connection pool the process owns.
//
// A pool rather than a single connection because every transaction needs a
// connection to itself for the duration of that transaction (see withTransaction.js):
// with one shared connection, two concurrent requests would interleave their
// statements inside each other's transaction, which is exactly the class of bug the
// transactions exist to prevent.
//
// Created lazily on first use so that merely requiring a service module does not
// open sockets -- which is what lets app.js be imported by Supertest without a
// database, and what lets the config loader's own tests run without one.

const mysql = require('mysql2/promise');

let pool = null;

/**
 * Pool options that are decisions rather than defaults:
 *
 * - namedPlaceholders: off. Every query in this codebase uses positional `?`
 *   placeholders, which mysql2 escapes; string interpolation into SQL appears
 *   nowhere, so there is no SQL-injection surface to begin with.
 * - multipleStatements: OFF, deliberately. It is off by default and is left off:
 *   turning it on would let a single injected `;` chain a second statement, which
 *   is the one thing that turns an escaping mistake into a full compromise. The
 *   schema loader (scripts/migrate.js) splits its own statements instead.
 * - dateStrings: off. DATETIME(3) columns come back as JS Date objects, matching
 *   what the previous Mongoose models returned, so controllers serialise them the
 *   same way and the API's timestamp format is unchanged.
 * - connectionLimit 10: comfortably above the concurrency the test suite creates
 *   (its heaviest property test fires 5 simultaneous requests) while staying well
 *   under a default RDS max_connections.
 * - enableKeepAlive: managed MySQL behind a load balancer (RDS) drops idle TCP
 *   connections; keepalive stops a pooled connection going stale between requests.
 */
function poolOptions(mysqlConfig) {
    return {
        ...mysqlConfig,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        multipleStatements: false,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        // Quantities are INT/INT UNSIGNED and always fit a JS number exactly, so no
        // BIGINT-to-string coercion is needed anywhere in this schema.
        supportBigNumbers: false,
    };
}

/**
 * The process-wide pool, created on first call.
 *
 * @param {object} [mysqlConfig] connection settings; defaults to `config.mysql`.
 *   The test harness passes its own (pointing at the test database) before any
 *   service module runs a query.
 * @returns {import('mysql2/promise').Pool}
 */
function getPool(mysqlConfig) {
    if (!pool) {
        // Required lazily so supplying a config never triggers the config loader's
        // fail-fast environment check (the same reason connect() does this).
        const settings = mysqlConfig || require('../config').mysql;
        pool = mysql.createPool(poolOptions(settings));
    }
    return pool;
}

/**
 * Runs one statement on the pool and returns the rows.
 *
 * `pool.query` is used rather than `pool.execute` because execute() caches a
 * prepared statement per unique SQL string on each connection, and the list
 * queries here build their WHERE clause from optional filters -- a shape that
 * would grow the prepared-statement cache without ever reusing most entries.
 * Escaping of `params` is identical either way.
 *
 * @param {string} sql statement with positional `?` placeholders
 * @param {any[]} [params]
 * @returns {Promise<any[]>}
 */
async function query(sql, params = []) {
    const [rows] = await getPool().query(sql, params);
    return rows;
}

/** Closes the pool. Called by the graceful-shutdown path and by test teardown. */
async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

/** True when a pool is currently open. Used by tests asserting teardown. */
const isPoolOpen = () => pool !== null;

module.exports = { getPool, query, closePool, isPoolOpen, poolOptions };

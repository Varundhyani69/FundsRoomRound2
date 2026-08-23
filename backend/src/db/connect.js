// backend/src/db/connect.js -- opens the MySQL pool and verifies the deployment can
// actually do what this application needs before the port is bound (Req 8.1, 8.6).
//
// The MongoDB version of this file had to check for a replica set, because
// multi-document transactions were unavailable on a standalone server. MySQL needs
// no such deployment shape -- InnoDB gives transactions on a single ordinary server
// -- so that entire class of setup friction is gone. What is worth checking instead
// is that the tables are actually InnoDB: on MyISAM every BEGIN/COMMIT would be
// silently ignored and every guarantee in this codebase would quietly evaporate.

const { getPool, closePool, query } = require('./pool');

/** Tables whose storage engine decides whether transactions work at all. */
const TRANSACTIONAL_TABLES = [
    'inventory_records',
    'inventory_transactions',
    'internal_transfers',
    'customer_orders',
    'customer_order_reservations',
];

/**
 * Reports the MySQL server version, e.g. "8.0.46".
 * @returns {Promise<string>}
 */
async function getServerVersion() {
    const rows = await query('SELECT VERSION() AS version');
    return rows[0].version;
}

/**
 * Names any of the application's transactional tables that are not InnoDB, plus any
 * that are missing entirely.
 *
 * @returns {Promise<{ nonInnoDb: string[], missing: string[] }>}
 */
async function checkStorageEngines() {
    // Both columns are aliased explicitly: MySQL 8 returns information_schema
    // column names in UPPERCASE, so reading `row.engine` off an unaliased `engine`
    // column yields undefined and would report every table as non-InnoDB.
    const rows = await query(
        `SELECT table_name AS tableName, engine AS engine
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN (${TRANSACTIONAL_TABLES.map(() => '?').join(', ')})`,
        TRANSACTIONAL_TABLES
    );

    const byName = new Map(rows.map((row) => [row.tableName, row.engine]));

    return {
        nonInnoDb: TRANSACTIONAL_TABLES.filter(
            (name) => byName.has(name) && String(byName.get(name)).toUpperCase() !== 'INNODB'
        ),
        missing: TRANSACTIONAL_TABLES.filter((name) => !byName.has(name)),
    };
}

/**
 * Opens the pool and logs one startup line about the deployment's state.
 *
 * @param {object} [mysqlConfig] Optional connection settings override. Omitted in
 *   production so the settings come from the config module, which is the only
 *   reader of process.env (Req 10.4). The test harness passes the test database's.
 */
async function connect(mysqlConfig) {
    getPool(mysqlConfig);

    // A trivial round trip, so a bad host/credential fails here -- before the port
    // is bound -- rather than on the first real request.
    const version = await getServerVersion();

    const { nonInnoDb, missing } = await checkStorageEngines();

    if (missing.length === TRANSACTIONAL_TABLES.length) {
        console.warn(
            `[db] connected to MySQL ${version}; the schema is not present. ` +
            'Run `npm run migrate` to create it before serving requests.'
        );
    } else if (missing.length > 0) {
        console.warn(
            `[db] connected to MySQL ${version}; these tables are missing: ` +
            `${missing.join(', ')}. Run \`npm run migrate\`.`
        );
    } else if (nonInnoDb.length > 0) {
        // Worth shouting about: the application would appear to work while silently
        // discarding every rollback.
        console.error(
            `[db] connected to MySQL ${version}, but these tables are NOT InnoDB: ` +
            `${nonInnoDb.join(', ')}. Transactions are silently ignored on other ` +
            'engines, so stock movements would not be atomic. Re-create the schema ' +
            'with `npm run migrate`.'
        );
    } else {
        console.log(
            `[db] connected to MySQL ${version}; InnoDB confirmed, transactions available`
        );
    }

    return getPool();
}

/**
 * Closes the pool, which ends every open connection and rolls back any transaction
 * still in progress on them (Req 8.4).
 */
async function disconnect() {
    await closePool();
}

module.exports = {
    connect,
    disconnect,
    getServerVersion,
    checkStorageEngines,
    TRANSACTIONAL_TABLES,
};

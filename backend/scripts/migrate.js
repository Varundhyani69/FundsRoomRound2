// backend/scripts/migrate.js -- creates the database if absent and applies
// src/db/schema.sql to it. Run with `npm run migrate`.
//
// Idempotent: every statement in schema.sql is `CREATE TABLE IF NOT EXISTS`, so
// running this against an already-migrated database is a no-op. That is what lets
// the same command serve a first-time local setup, a redeploy, and the test
// harness's per-run schema creation without three different code paths.
//
// This is deliberately a plain SQL file plus a runner rather than a versioned
// migration framework. The project has one schema and no production data to
// preserve across shape changes, so a migration tool would add a dependency and a
// directory of numbered files without answering a question this project has.

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'db', 'schema.sql');

/**
 * Splits a SQL file into individual statements.
 *
 * The pool runs with `multipleStatements: false` (see src/db/pool.js), so the file
 * cannot be sent in one call and has to be split here. This is a deliberately
 * simple splitter: it strips `--` line comments and splits on `;`. That is
 * sufficient for schema.sql, which contains no stored routines, no `BEGIN ... END`
 * blocks, and no semicolons inside string literals -- the three things that would
 * require a real SQL parser. A statement is validated to be non-empty before being
 * run, so a trailing semicolon does not produce an empty query.
 *
 * @param {string} sql
 * @returns {string[]}
 */
function splitStatements(sql) {
    return sql
        .split('\n')
        .map((line) => {
            // Strip a `--` comment, but only when it starts a comment: `--` must be
            // followed by whitespace or end-of-line per the SQL standard, which also
            // means a string containing "--" is left alone.
            const commentAt = line.search(/--(\s|$)/);
            return commentAt === -1 ? line : line.slice(0, commentAt);
        })
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
}

/**
 * Applies the schema to an already-selected database.
 *
 * @param {import('mysql2/promise').Connection} connection
 * @returns {Promise<number>} how many statements ran
 */
async function applySchema(connection) {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const statements = splitStatements(sql);

    for (const statement of statements) {
        await connection.query(statement);
    }

    return statements.length;
}

/**
 * Creates `database` if it does not exist, then applies the schema to it.
 *
 * Exported so the test harness can build its own throwaway database through the
 * exact same code path a deployment uses -- if the schema were applied two
 * different ways, a test could pass against a schema production never gets.
 *
 * @param {object} mysqlConfig `{ host, port, user, password, database }`
 * @returns {Promise<{ database: string, statements: number }>}
 */
async function migrate(mysqlConfig) {
    const { database, ...serverConfig } = mysqlConfig;

    if (!database) {
        throw new Error('migrate() requires a database name');
    }

    // Connect WITHOUT selecting a database, because it may not exist yet.
    const connection = await mysql.createConnection(serverConfig);

    try {
        // The identifier cannot be a `?` placeholder -- placeholders are for values,
        // not identifiers -- so it is backtick-quoted with any backtick in the name
        // escaped, which is how mysql2's own escapeId works.
        const quoted = `\`${String(database).replace(/`/g, '``')}\``;
        await connection.query(
            `CREATE DATABASE IF NOT EXISTS ${quoted} ` +
            'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs'
        );
        await connection.query(`USE ${quoted}`);

        const statements = await applySchema(connection);
        return { database, statements };
    } finally {
        await connection.end();
    }
}

/** Drops a database. Used only by the test harness's teardown. */
async function dropDatabase(mysqlConfig) {
    const { database, ...serverConfig } = mysqlConfig;
    const connection = await mysql.createConnection(serverConfig);
    try {
        const quoted = `\`${String(database).replace(/`/g, '``')}\``;
        await connection.query(`DROP DATABASE IF EXISTS ${quoted}`);
    } finally {
        await connection.end();
    }
}

async function main() {
    // Required here rather than at the top so `require`-ing this module for its
    // exports (as the test harness does) never triggers the config loader's
    // fail-fast environment check.
    const config = require('../src/config');

    const { database, statements } = await migrate(config.mysql);
    console.log(
        `Schema applied to "${database}": ${statements} statement(s) executed. ` +
        'Re-running this command is safe.'
    );
    return 0;
}

// Only run when invoked directly (`npm run migrate`), not when required by a test.
if (require.main === module) {
    main()
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error) => {
            console.error(`Migration failed: ${error.message}`);
            process.exitCode = 1;
        });
}

module.exports = { migrate, dropDatabase, applySchema, splitStatements, SCHEMA_PATH };

// backend/tests/setup/globalSetup.js -- creates one throwaway MySQL database for the whole
// run and applies the real schema to it (Req 12.8).
//
// This replaced an in-memory MongoDB replica set. There is no equivalent in-memory MySQL, so
// the suite connects to the same MySQL server the developer already runs and creates a
// SEPARATE database beside the application's own, named `<MYSQL_DATABASE>_test`. That
// database is dropped and recreated at the start of every run, so a previous run's rows can
// never leak into this one, and the application's database is never touched by the tests.
//
// The schema comes from scripts/migrate.js -- the very same code path `npm run migrate` uses
// -- so the tests exercise the exact schema a deployment gets. If they were built two
// different ways, a test could pass against a schema production never receives.
//
// jest runs this file in its own process, so assignments to process.env here are not
// guaranteed to reach the test workers. The resolved values are therefore also written to a
// small JSON file that dbSetup.js reads back into process.env inside every worker, before
// anything requires src/config (which exits non-zero on a missing variable).

const fs = require('fs');
const path = require('path');
const { migrate, dropDatabase } = require('../../scripts/migrate');

// Gitignored handoff file between this process and the test workers.
const ENV_FILE = path.join(__dirname, '.test-env.json');

// Suffix rather than a fixed name, so a developer pointing MYSQL_DATABASE at something else
// still gets an obviously-derived test database next to it.
const TEST_DB_SUFFIX = '_test';

// The variables src/config requires beyond the MYSQL_* set. JWT_SECRET is deliberately 40
// characters, above the 32-character minimum the config loader enforces (Req 10.10).
const STATIC_ENV = {
    JWT_SECRET: 'test-secret-at-least-32-characters-long!',
    PORT: '4000',
    CORS_ORIGIN: 'http://localhost:5173',
};

/**
 * Reads the developer's MySQL connection settings from the environment / .env, without going
 * through src/config -- which would demand every variable the SERVER needs and exit the
 * process if one were missing, before the harness has had a chance to explain why.
 */
function readMysqlEnv() {
    require('dotenv').config();

    const missing = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_DATABASE'].filter(
        (name) => typeof process.env[name] !== 'string' || process.env[name].trim() === ''
    );
    if (typeof process.env.MYSQL_PASSWORD !== 'string') {
        missing.push('MYSQL_PASSWORD');
    }

    if (missing.length > 0) {
        process.stderr.write(
            '[test harness] Aborting before any test ran: these environment variables are ' +
            `missing: ${missing.join(', ')}. The suite needs MySQL connection settings in ` +
            'backend/.env (see backend/.env.example) so it can create its own throwaway ' +
            'test database.\n'
        );
        process.exit(1);
    }

    return {
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT),
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: `${process.env.MYSQL_DATABASE}${TEST_DB_SUFFIX}`,
    };
}

module.exports = async () => {
    const mysqlConfig = readMysqlEnv();

    try {
        // Dropped first, so the run starts from an empty schema no matter how a previous run
        // ended (including one killed mid-test).
        await dropDatabase(mysqlConfig);
        await migrate(mysqlConfig);
    } catch (error) {
        process.stderr.write(
            `[test harness] Aborting before any test ran: could not prepare the test ` +
            `database "${mysqlConfig.database}": ${error.message}\n` +
            'Check that MySQL is running and that MYSQL_USER may create databases.\n'
        );
        process.exit(1);
    }

    const env = {
        MYSQL_HOST: mysqlConfig.host,
        MYSQL_PORT: String(mysqlConfig.port),
        MYSQL_USER: mysqlConfig.user,
        MYSQL_PASSWORD: mysqlConfig.password,
        MYSQL_DATABASE: mysqlConfig.database,
        ...STATIC_ENV,
    };

    Object.assign(process.env, env);
    fs.writeFileSync(ENV_FILE, JSON.stringify(env, null, 2), 'utf8');

    // globalTeardown reads this to drop the database again.
    globalThis.__TEST_MYSQL__ = mysqlConfig;
};

module.exports.ENV_FILE = ENV_FILE;
module.exports.TEST_DB_SUFFIX = TEST_DB_SUFFIX;

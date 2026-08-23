// backend/tests/setup/assertTransactional.js -- the transactional-storage precondition
// (Req 12.9).
//
// This replaced `assertReplicaSet.js`. Under MongoDB the risk was running against a
// standalone server, where a multi-document transaction is simply unavailable. MySQL has no
// such deployment requirement, but it has a quieter equivalent failure: on a non-InnoDB
// engine, BEGIN/COMMIT/ROLLBACK are accepted and then silently ignored. Every rollback
// assertion in this suite would pass for the wrong reason -- nothing was rolled back because
// nothing was ever transactional.
//
// So the check is the same in spirit: prove the deployment can actually do transactions
// before any test runs, and abort loudly with the reason if it cannot.

const { checkStorageEngines, TRANSACTIONAL_TABLES } = require('../../src/db/connect');

async function assertTransactional() {
    let engines = null;
    let failure = null;

    try {
        engines = await checkStorageEngines();
    } catch (error) {
        failure = error.message;
    }

    if (failure) {
        process.stderr.write(
            `[test harness] Aborting before any test ran: could not read the storage engines ` +
            `of the test schema: ${failure}\n`
        );
        process.exit(1);
    }

    if (engines.missing.length > 0) {
        process.stderr.write(
            `[test harness] Aborting before any test ran: these tables are missing from the ` +
            `test database: ${engines.missing.join(', ')}. globalSetup should have created ` +
            'them from src/db/schema.sql -- run the suite through `npm test`.\n'
        );
        process.exit(1);
    }

    if (engines.nonInnoDb.length > 0) {
        process.stderr.write(
            `[test harness] Aborting before any test ran: these tables are not InnoDB: ` +
            `${engines.nonInnoDb.join(', ')}. Transactions are silently ignored on other ` +
            'engines, so every rollback assertion in this suite would pass without anything ' +
            'actually being rolled back.\n'
        );
        process.exit(1);
    }

    return TRANSACTIONAL_TABLES.length;
}

module.exports = assertTransactional;

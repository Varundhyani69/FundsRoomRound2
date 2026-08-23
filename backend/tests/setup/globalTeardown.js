// backend/tests/setup/globalTeardown.js -- drops the throwaway test database and removes the
// environment handoff file, so a run leaves no schema and no stray file behind.
//
// The database is dropped rather than merely emptied: leaving `<db>_test` sitting on the
// developer's MySQL server after every run would accumulate a schema nobody asked for, and
// globalSetup drops it again on the next run anyway.

const fs = require('fs');
const { ENV_FILE } = require('./globalSetup');
const { dropDatabase } = require('../../scripts/migrate');

module.exports = async () => {
    const mysqlConfig = globalThis.__TEST_MYSQL__;

    if (mysqlConfig) {
        try {
            await dropDatabase(mysqlConfig);
        } catch (error) {
            // Teardown must not fail the run: the tests have already finished by this point,
            // and a leftover test database is a nuisance rather than a failure. Report it and
            // move on.
            process.stderr.write(
                `[test harness] Could not drop the test database ` +
                `"${mysqlConfig.database}": ${error.message}\n`
            );
        }
        delete globalThis.__TEST_MYSQL__;
    }

    if (fs.existsSync(ENV_FILE)) {
        fs.unlinkSync(ENV_FILE);
    }
};

// backend/tests/setup/assertReplicaSet.js -- the replica-set precondition (Req 12.9).
// Runs the `hello` admin command over the open connection; when the deployment reports
// no `setName` the reason goes to standard error and the process exits non-zero before
// any test executes, because every stock movement in this system runs inside a
// multi-document Transaction and those require a replica set.

const { getReplicaSetName } = require('../../src/db/connect');

async function assertReplicaSet() {
    let setName = null;
    let failure = null;

    try {
        setName = await getReplicaSetName();
    } catch (error) {
        failure = error.message;
    }

    if (!setName) {
        const reason = failure
            ? `the hello command failed: ${failure}`
            : 'the deployment reported no setName, so it is a standalone server';
        process.stderr.write(
            `[test harness] Aborting before any test ran: ${reason}. ` +
            'The test suite requires a MongoDB replica-set deployment because every ' +
            'inventory movement is committed in a multi-document transaction.\n'
        );
        process.exit(1);
    }

    return setName;
}

module.exports = assertReplicaSet;

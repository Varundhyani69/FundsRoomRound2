// backend/src/db/connect.js -- opens the Mongoose connection and reports whether the
// deployment is a replica set, because multi-document transactions require one (Req 8.1, 8.6).

const mongoose = require('mongoose');

/**
 * Reports the replica-set name of the connected deployment, or null when the
 * deployment reports none (a standalone server).
 */
async function getReplicaSetName() {
    const result = await mongoose.connection.db.admin().command({ hello: 1 });
    return result && result.setName ? result.setName : null;
}

/**
 * Opens the Mongoose connection and logs one startup line about the replica-set state.
 *
 * @param {string} [uri] Optional connection string override. Omitted in production so
 *   the URI comes from the config module, which is the only reader of process.env
 *   (Req 10.4). The test harness passes the in-memory replica set URI.
 */
async function connect(uri) {
    // Required lazily so that supplying a URI never triggers the config loader's
    // fail-fast environment check.
    const mongoUri = uri || require('../config').mongoUri;

    await mongoose.connect(mongoUri);

    const setName = await getReplicaSetName();
    if (setName) {
        console.log(`[db] connected; replica set "${setName}" reported, transactions available`);
    } else {
        console.warn(
            '[db] connected; the deployment reports no replica-set name. ' +
            'MongoDB multi-document transactions require a replica set, so every stock ' +
            'movement will fail until the deployment is initiated as one (see README).'
        );
    }

    return mongoose.connection;
}

/**
 * Closes the Mongoose connection, which ends open sessions and aborts their
 * in-progress transactions (Req 8.4).
 */
async function disconnect() {
    await mongoose.disconnect();
}

module.exports = { connect, disconnect, getReplicaSetName };

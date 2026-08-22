// backend/tests/setup/globalSetup.js -- starts one in-memory MongoDB replica set for
// the whole run, so multi-document Transactions work and `npm test` needs no external
// MongoDB (Req 12.8).
//
// jest runs this file in its own process, so assignments to process.env here are not
// guaranteed to reach the test workers. The resolved values are therefore also written
// to a small JSON file that dbSetup.js reads back into process.env inside every worker,
// before anything requires src/config (which exits non-zero on a missing variable).

const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Gitignored handoff file between this process and the test workers.
const ENV_FILE = path.join(__dirname, '.mongo-uri.json');

const TEST_DB_NAME = 'mini_operations_erp_test';

// The four variables src/config requires. JWT_SECRET is deliberately 40 characters,
// above the 32-character minimum the config loader enforces (Req 10.10).
const STATIC_ENV = {
    JWT_SECRET: 'test-secret-at-least-32-characters-long!',
    PORT: '4000',
    CORS_ORIGIN: 'http://localhost:5173',
};

module.exports = async () => {
    const replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
    });

    const env = {
        MONGODB_URI: replSet.getUri(TEST_DB_NAME),
        ...STATIC_ENV,
    };

    Object.assign(process.env, env);
    fs.writeFileSync(ENV_FILE, JSON.stringify(env, null, 2), 'utf8');

    // globalTeardown reads this handle to stop the replica set.
    globalThis.__MONGO_REPLSET__ = replSet;
};

module.exports.ENV_FILE = ENV_FILE;

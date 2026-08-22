// backend/tests/setup/dbSetup.js -- loaded through setupFilesAfterEnv, so it is
// evaluated inside every worker BEFORE the test file (and therefore before src/app
// and src/config) is required.
//
// Order matters here: the four environment variables must be in place before any
// module that reaches src/config is required, because that module exits non-zero on a
// missing variable (Req 10.2).

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.mongo-uri.json');

if (!fs.existsSync(ENV_FILE)) {
    throw new Error(
        `Test environment file ${ENV_FILE} is missing. Run the suite through ` +
        '`npm test` so jest globalSetup starts the in-memory replica set first.'
    );
}

const testEnv = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
for (const [name, value] of Object.entries(testEnv)) {
    process.env[name] = value;
}

// Safe to require modules that read the resolved config from here on.
const mongoose = require('mongoose');
const { connect, disconnect } = require('../../src/db/connect');
const assertReplicaSet = require('./assertReplicaSet');
const { seedFixture } = require('./seedFixture');

// One connection per worker, opened once for the whole file.
beforeAll(async () => {
    await connect(process.env.MONGODB_URI);
    await assertReplicaSet();
});

// Per-test reset: every document of every collection is removed and the fixed seed
// fixture is loaded again, so every test starts from the same known state and the suite
// passes in any execution order (Req 12.11). The fixture contents live in
// tests/setup/seedFixture.js.
beforeEach(async () => {
    const collections = Object.values(mongoose.connection.collections);
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
    await seedFixture();
});

afterAll(async () => {
    await disconnect();
});

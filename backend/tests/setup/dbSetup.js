// backend/tests/setup/dbSetup.js -- loaded through setupFilesAfterEnv, so it is evaluated
// inside every worker BEFORE the test file (and therefore before src/app and src/config) is
// required.
//
// Order matters here: the environment variables must be in place before any module that
// reaches src/config is required, because that module exits non-zero on a missing variable
// (Req 10.2).

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.test-env.json');

if (!fs.existsSync(ENV_FILE)) {
    throw new Error(
        `Test environment file ${ENV_FILE} is missing. Run the suite through \`npm test\` so ` +
        "jest's globalSetup creates the throwaway MySQL test database first."
    );
}

const testEnv = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
for (const [name, value] of Object.entries(testEnv)) {
    process.env[name] = value;
}

// Safe to require modules that read the resolved config from here on.
const { connect, disconnect } = require('../../src/db/connect');
const { query } = require('../../src/db/pool');
const assertTransactional = require('./assertTransactional');
const { seedFixture } = require('./seedFixture');

// The tables the per-test reset empties, in an order that respects the foreign keys when read
// top to bottom (children before parents). TRUNCATE is not used because it cannot run against
// a table another table references; DELETE can, provided the order is right.
const TABLES_CHILD_FIRST = [
    'customer_order_reservations',
    'customer_orders',
    'internal_transfers',
    'inventory_transactions',
    'inventory_records',
    'work_orders',
    'users',
    'items',
    'categories',
    'locations',
];

// One pool per worker, opened once for the whole file.
beforeAll(async () => {
    await connect();
    await assertTransactional();
});

// Per-test reset: every row of every table is removed and the fixed seed fixture is loaded
// again, so every test starts from the same known state and the suite passes in any execution
// order (Req 12.11). The fixture contents live in tests/setup/seedFixture.js.
//
// Deleting child tables before parents keeps every foreign key satisfied at each step, which
// is deliberately preferred over disabling FOREIGN_KEY_CHECKS: the constraints are part of
// what the tests are meant to be running against, so switching them off between tests would
// hide a genuine ordering mistake in the application.
beforeEach(async () => {
    for (const table of TABLES_CHILD_FIRST) {
        await query(`DELETE FROM ${table}`);
    }
    await seedFixture();
});

afterAll(async () => {
    await disconnect();
});

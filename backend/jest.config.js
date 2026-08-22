// backend/jest.config.js -- one documented command drives the whole suite:
// `npm test` -> `jest --runInBand` (Req 12.10).

/** @type {import('jest').Config} */
module.exports = {
    rootDir: __dirname,

    // Plain Node, no jsdom: the suite drives the Express app in-process (Req 12.13).
    testEnvironment: 'node',

    // Starts and stops the single-node in-memory replica set once for the run,
    // so Transaction behaviour is exercised rather than stubbed (Req 12.8).
    globalSetup: '<rootDir>/tests/setup/globalSetup.js',
    globalTeardown: '<rootDir>/tests/setup/globalTeardown.js',

    // Per-worker wiring: environment variables, the Mongoose connection, the
    // replica-set precondition check (Req 12.9), and the per-test reset (Req 12.11).
    setupFilesAfterEnv: ['<rootDir>/tests/setup/dbSetup.js'],

    testMatch: ['<rootDir>/tests/**/*.test.js'],

    // Serial execution: every test file shares the one replica set. `--runInBand`
    // in the npm script says the same thing; this keeps it true however jest is invoked.
    maxWorkers: 1,

    // Starting the replica set and the property-based tests are both slow.
    testTimeout: 60000,

    clearMocks: true,
};

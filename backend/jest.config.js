// backend/jest.config.js -- one documented command drives the whole suite:
// `npm test` -> `jest --runInBand` (Req 12.10).

/** @type {import('jest').Config} */
module.exports = {
    rootDir: __dirname,

    // Plain Node, no jsdom: the suite drives the Express app in-process (Req 12.13).
    testEnvironment: 'node',

    // Creates and drops the throwaway MySQL test database once for the run, applying the
    // real schema to it, so transaction behaviour is exercised against InnoDB rather than
    // stubbed (Req 12.8).
    globalSetup: '<rootDir>/tests/setup/globalSetup.js',
    globalTeardown: '<rootDir>/tests/setup/globalTeardown.js',

    // Per-worker wiring: environment variables, the MySQL pool, the transactional-storage
    // precondition check (Req 12.9), and the per-test reset (Req 12.11).
    setupFilesAfterEnv: ['<rootDir>/tests/setup/dbSetup.js'],

    testMatch: ['<rootDir>/tests/**/*.test.js'],

    // Serial execution: every test file shares the one test database, and the concurrency
    // tests deliberately contend for the same rows. `--runInBand` in the npm script says the
    // same thing; this keeps it true however jest is invoked.
    maxWorkers: 1,

    // The property-based tests replay long generated sequences against a real database.
    testTimeout: 60000,

    clearMocks: true,
};

// backend/tests/properties/api.pbt.test.js -- property-based tests for the API.
// One top-level `describe` per numbered property from design.md, so later increments
// append a block rather than editing existing ones.
//
// fast-check reports the failing seed and the shrunk counterexample on failure, so any
// reported case is reproducible (Req 12.7).

const fc = require('fast-check');

const { loadConfig, REQUIRED } = require('../../src/config');

// At least 25 runs per property (Req 12.7). These properties are pure, so more runs
// cost almost nothing.
const RUNS = { numRuns: 100 };

const VALID_ENV = Object.freeze({
    MONGODB_URI: 'mongodb://127.0.0.1:27017/mini_operations_erp',
    JWT_SECRET: 'a'.repeat(40),
    PORT: '4000',
    CORS_ORIGIN: 'http://localhost:5173',
});

// The loader's own definition of blank: absent, empty, or whitespace only.
const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

// Feature: mini-operations-erp, Property 18: The config loader accepts exactly the valid environments
describe('Property 18: The config loader accepts exactly the valid environments', () => {
    // Non-empty subsets of the four required names, in declaration order.
    const genRequiredSubset = fc.subarray(REQUIRED, { minLength: 1 });

    // Each way a variable can be blank, including removing it altogether.
    const genBlankForm = fc.constantFrom(undefined, '', ' ', '\t', '   \n  ');

    const genPortString = fc.oneof(
        fc.string({ maxLength: 8 }),
        fc.integer({ min: -1000, max: 70000 }).map(String),
        fc.nat({ max: 65535 }).map(String),
        fc.constantFrom('0', '1', '65535', '65536', '40.5', '0x10', '1e3', ' 4000 ', '+80', '007')
    );

    const genSecretString = fc.oneof(
        fc.string({ maxLength: 64 }),
        fc.string({ minLength: 28, maxLength: 64 }),
        fc.integer({ min: 0, max: 64 }).map((length) => 'x'.repeat(length))
    );

    test('every non-empty blanked subset fails with a single message naming exactly that subset', () => {
        fc.assert(
            fc.property(genRequiredSubset, fc.array(genBlankForm, { minLength: 4, maxLength: 4 }), (subset, blanks) => {
                const env = { ...VALID_ENV };
                subset.forEach((name, index) => {
                    const blank = blanks[index % blanks.length];
                    if (blank === undefined) {
                        delete env[name];
                    } else {
                        env[name] = blank;
                    }
                });

                const result = loadConfig(env);

                // Non-zero exit is what loadOrExit does with any !ok result; the pure
                // loader reports it as ok: false with the messages to print.
                expect(result.ok).toBe(false);
                expect(result.errors).toHaveLength(1);
                expect(result.errors[0]).toBe(
                    `Missing required environment variables: ${subset.join(', ')}`
                );

                // Exactly that subset: no other required name is named.
                const named = result.errors[0]
                    .replace('Missing required environment variables: ', '')
                    .split(', ');
                expect(named).toEqual(subset);
                for (const name of REQUIRED.filter((n) => !subset.includes(n))) {
                    expect(named).not.toContain(name);
                }
            }),
            RUNS
        );
    });

    test('startup proceeds for a port exactly when it is a decimal integer from 1 to 65535', () => {
        fc.assert(
            fc.property(genPortString, (portValue) => {
                const result = loadConfig({ ...VALID_ENV, PORT: portValue });

                const shouldPass =
                    /^\d+$/.test(portValue) &&
                    Number(portValue) >= 1 &&
                    Number(portValue) <= 65535;

                expect(result.ok).toBe(shouldPass);

                if (shouldPass) {
                    expect(result.config.port).toBe(Number(portValue));
                    expect(Number.isInteger(result.config.port)).toBe(true);
                } else if (isBlank(portValue)) {
                    // A blank port is a missing variable, reported first and alone.
                    expect(result.errors).toEqual([
                        'Missing required environment variables: PORT',
                    ]);
                } else {
                    expect(result.errors).toHaveLength(1);
                    expect(result.errors[0]).toContain('PORT');
                }
            }),
            RUNS
        );
    });

    test('startup proceeds for a secret exactly when its length is at least 32', () => {
        fc.assert(
            fc.property(genSecretString, (secret) => {
                const result = loadConfig({ ...VALID_ENV, JWT_SECRET: secret });

                const shouldPass = !isBlank(secret) && secret.length >= 32;

                expect(result.ok).toBe(shouldPass);

                if (shouldPass) {
                    expect(result.config.jwtSecret).toBe(secret);
                } else if (isBlank(secret)) {
                    expect(result.errors).toEqual([
                        'Missing required environment variables: JWT_SECRET',
                    ]);
                } else {
                    expect(result.errors).toHaveLength(1);
                    expect(result.errors[0]).toContain('JWT_SECRET');
                }
            }),
            RUNS
        );
    });
});

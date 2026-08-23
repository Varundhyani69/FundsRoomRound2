// backend/tests/properties/api.pbt.test.js -- property-based tests for the API.
// One top-level `describe` per numbered property from design.md, so later increments
// append a block rather than editing existing ones.
//
// fast-check reports the failing seed and the shrunk counterexample on failure, so any
// reported case is reproducible (Req 12.7).

const fc = require('fast-check');
const { Item, InventoryRecord, WorkOrder, InternalTransfer, CustomerOrder } = require('../setup/tables');

const { loadConfig, REQUIRED } = require('../../src/config');

// Exactly the numRuns: 25 floor of Req 12.7 -- the minimum, kept for suite speed.
const RUNS = { numRuns: 25 };

const VALID_ENV = Object.freeze({
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'erp_test',
    MYSQL_PASSWORD: 'not-a-real-password',
    MYSQL_DATABASE: 'mini_operations_erp',
    JWT_SECRET: 'a'.repeat(40),
    PORT: '4000',
    CORS_ORIGIN: 'http://localhost:5173',
});

// The loader's own definition of blank: absent, empty, or whitespace only.
const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

// Feature: mini-operations-erp, Property 18: The config loader accepts exactly the valid environments
describe('Property 18: The config loader accepts exactly the valid environments', () => {
    // Non-empty subsets of the required names, in declaration order.
    const genRequiredSubset = fc.subarray(REQUIRED, { minLength: 1 });

    // Each way a variable can be blank, including removing it altogether.
    const genBlankForm = fc.constantFrom(undefined, '', ' ', '\t', '   \n  ');

    // MYSQL_PASSWORD is the one required variable the loader checks for PRESENCE only: a
    // local MySQL user with no password is a legitimate setup, so an empty or whitespace
    // value is accepted and only an ABSENT variable is missing. Every other required name
    // treats any blank form as missing. Modelling that here rather than dropping
    // MYSQL_PASSWORD from the generator keeps the property covering it in both directions --
    // absent must fail, empty must not.
    const isMissingToLoader = (name, blankForm) =>
        name === 'MYSQL_PASSWORD' ? blankForm === undefined : true;

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

    test('every blanked subset fails with a single message naming exactly the variables the loader counts as missing', () => {
        fc.assert(
            fc.property(
                genRequiredSubset,
                // One independent blank form per required name, so which variable gets which
                // form is part of what the property explores.
                fc.array(genBlankForm, {
                    minLength: REQUIRED.length,
                    maxLength: REQUIRED.length,
                }),
                (subset, blanks) => {
                    const env = { ...VALID_ENV };
                    const blankedWith = new Map();

                    subset.forEach((name, index) => {
                        const blank = blanks[index % blanks.length];
                        blankedWith.set(name, blank);
                        if (blank === undefined) {
                            delete env[name];
                        } else {
                            env[name] = blank;
                        }
                    });

                    // Filtered from REQUIRED rather than from `subset`, so the expected order
                    // is the loader's declaration order by construction.
                    const expectedMissing = REQUIRED.filter(
                        (name) =>
                            blankedWith.has(name) &&
                            isMissingToLoader(name, blankedWith.get(name))
                    );

                    const result = loadConfig(env);

                    // The subset blanked only MYSQL_PASSWORD, and blanked it to a present-but-
                    // empty value -- which the loader accepts, so nothing is missing.
                    if (expectedMissing.length === 0) {
                        expect(result.ok).toBe(true);
                        return;
                    }

                    // Non-zero exit is what loadOrExit does with any !ok result; the pure
                    // loader reports it as ok: false with the messages to print.
                    expect(result.ok).toBe(false);
                    expect(result.errors).toHaveLength(1);
                    expect(result.errors[0]).toBe(
                        `Missing required environment variables: ${expectedMissing.join(', ')}`
                    );

                    // Exactly those names: no other required name is named.
                    const named = result.errors[0]
                        .replace('Missing required environment variables: ', '')
                        .split(', ');
                    expect(named).toEqual(expectedMissing);
                    for (const name of REQUIRED.filter((n) => !expectedMissing.includes(n))) {
                        expect(named).not.toContain(name);
                    }
                }
            ),
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

// --- additional requires for Properties 15, 16, 17 --------------------------------------
// Appended rather than merged into the block above so Property 18's own requires (fc,
// loadConfig, REQUIRED) stay untouched. Module loading order does not matter for CommonJS
// requires placed at the bottom of a file -- they still resolve before Jest invokes any
// `test()` callback below.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const ERROR_CODES = require('../../src/errors/errorCodes');
const { ROLES, WRITE_ROUTE_PERMISSIONS } = require('../../src/permissions');
const { withTransaction } = require('../../src/db/withTransaction');
const { agent } = require('../setup/agent');
const { getInUseConnectionCount } = require('../setup/poolCount');
const {
    callRoute,
    UNMAPPED_WRITE_ROUTE,
    READ_ROUTE,
} = require('../setup/authorizeTestApp');
const {
    FIXTURE_USERS,
    FIXTURE_ITEMS,
    FIXTURE_LOCATIONS,
    FIXTURE_CATEGORIES,
    FIXTURE_INVENTORY_RECORDS,
    tokenFor,
} = require('../setup/seedFixture');
const { genRole, genMalformedId, genUnusedObjectId } = require('../setup/generators');

// Feature: mini-operations-erp, Property 17: Sessions and retries are bounded
describe('Property 17: Sessions and retries are bounded', () => {
    // Pure DB-session mechanics -- withTransaction starts and ends a real session per
    // attempt against the real test database, but does no HTTP round trip and no
    // application-level write. Kept at exactly the numRuns: 25 floor of Req 12.7 for suite
    // speed.
    const RUNS_PROPERTY_17_RETRY = { numRuns: 25 };
    // Drives real HTTP requests through the exported app, the slower shape, so this stays
    // at the Req 12.7 floor.
    const RUNS_PROPERTY_17_SESSION = { numRuns: 25 };

    // A plain Error carrying the two fields mysql2 sets on a real InnoDB deadlock -- `code`
    // 'ER_LOCK_DEADLOCK' and `errno` 1213 -- which is exactly what withTransaction's
    // isTransient() inspects. Same technique as tests/transactions.test.js's single
    // k=4-always-fails case; here k ranges over 0..5 so the property covers both sides of the
    // retry boundary instead of only the one edge that unit test already pins down.
    //
    // Simulated rather than provoked because a genuine deadlock resolves on its retry, so it
    // can only ever produce k = 1. tests/concurrency.test.js covers the real thing.
    function makeTransientError() {
        const error = new Error('simulated transient transaction error');
        error.code = 'ER_LOCK_DEADLOCK';
        error.errno = 1213;
        error.sqlState = '40001';
        return error;
    }

    test('a callback that fails transiently k times then succeeds commits after exactly k+1 attempts when k <= 3, and exhausts with CONCURRENT_MODIFICATION after exactly 4 attempts when k > 3', async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (k) => {
                let callCount = 0;
                const sentinel = Symbol('withTransaction success');

                const callback = async () => {
                    callCount += 1;
                    if (callCount <= k) {
                        throw makeTransientError();
                    }
                    return sentinel;
                };

                if (k <= 3) {
                    const result = await withTransaction(callback);
                    expect(result).toBe(sentinel);
                    expect(callCount).toBe(k + 1);
                } else {
                    let thrown;
                    try {
                        await withTransaction(callback);
                    } catch (error) {
                        thrown = error;
                    }
                    expect(thrown).toBeDefined();
                    expect(thrown.code).toBe('CONCURRENT_MODIFICATION');
                    expect(thrown.status).toBe(409);
                    // 3 retries means at most 4 executions in total (Req 8.5), regardless
                    // of how far k overshoots that boundary.
                    expect(callCount).toBe(4);
                }
            }),
            RUNS_PROPERTY_17_RETRY
        );
    });

    test('the in-use pool connection count returns to its pre-request baseline after every request in a mix of succeeding and failing requests', async () => {
        const adminToken = await tokenFor('Admin');
        let counter = 0;

        const freshItem = async () => {
            const suffix = crypto.randomBytes(4).toString('hex');
            const item = await Item.create({
                code: `PBT-P17-${suffix}`,
                name: `Property 17 item ${suffix}`,
                category: FIXTURE_CATEGORIES.rawMaterial.id,
            });
            return String(item._id);
        };

        // One kind per request in the generated mix: a transactional success, a
        // validation failure that never opens a transaction at all, a NOT_FOUND that
        // aborts one after its first read, and a guard failure
        // (INSUFFICIENT_PHYSICAL_QUANTITY) that also aborts one -- covering both "never
        // entered a transaction" and "entered and aborted" shapes alongside a commit.
        const genRequestKind = fc.oneof(
            fc.constant({ kind: 'createValid' }),
            fc.constant({ kind: 'validationFailure' }),
            genUnusedObjectId.map((id) => ({ kind: 'notFound', id })),
            fc.constant({ kind: 'insufficientPhysical' })
        );
        const genMix = fc.array(genRequestKind, { minLength: 3, maxLength: 6 });

        await fc.assert(
            fc.asyncProperty(genMix, async (mix) => {
                // A record with headroom, created directly and outside the timing loop
                // below, so this setup write is never mistaken for one of the measured
                // requests.
                const helperItem = await freshItem();
                const helperRecord = await InventoryRecord.create({
                    item: helperItem,
                    location: FIXTURE_LOCATIONS.secondary.id,
                    batch: 'PROP17-HELPER',
                    physicalQuantity: 10,
                    reservedQuantity: 0,
                });

                for (const request of mix) {
                    const before = await getInUseConnectionCount();
                    let response;

                    if (request.kind === 'createValid') {
                        const item = await freshItem();
                        response = await agent()
                            .post('/api/inventory')
                            .set('Authorization', `Bearer ${adminToken}`)
                            .send({
                                item,
                                location: FIXTURE_LOCATIONS.secondary.id,
                                batch: `PROP17-${counter++}`,
                                physicalQuantity: 5,
                                movementReference: `prop17-create-${counter++}`,
                            });
                        expect(response.status).toBe(201);
                    } else if (request.kind === 'validationFailure') {
                        // No physicalQuantity and no movementReference: rejected by the
                        // Validation_Layer before any transaction is ever opened.
                        response = await agent()
                            .post('/api/inventory')
                            .set('Authorization', `Bearer ${adminToken}`)
                            .send({ item: helperItem, location: FIXTURE_LOCATIONS.secondary.id, batch: 'x' });
                        expect(response.status).toBe(400);
                    } else if (request.kind === 'notFound') {
                        response = await agent()
                            .post(`/api/inventory/${request.id}/adjust`)
                            .set('Authorization', `Bearer ${adminToken}`)
                            .send({ direction: 'IN', quantity: 1, movementReference: `prop17-nf-${counter++}` });
                        expect(response.status).toBe(404);
                    } else {
                        response = await agent()
                            .post(`/api/inventory/${helperRecord._id}/adjust`)
                            .set('Authorization', `Bearer ${adminToken}`)
                            .send({
                                direction: 'OUT',
                                quantity: 1_000_000,
                                movementReference: `prop17-insuff-${counter++}`,
                            });
                        expect(response.status).toBe(409);
                    }

                    const after = await getInUseConnectionCount();
                    expect(after).toBe(before);
                }
            }),
            RUNS_PROPERTY_17_SESSION
        );
    });
});

// A hygiene check reused by every rejection scenario in Property 15: the message must be a
// non-empty string naming no stack frame, file path, module name, or raw database error
// text (design.md Property 15, Req 9.6, 9.7).
function assertCleanMessage(message) {
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toMatch(/[\\/][\w.-]+\.js/i); // a file path
    expect(message).not.toMatch(/\bat\s+\S+\s*\(/); // a stack frame
    expect(message.toLowerCase()).not.toMatch(/mysql|er_dup_entry|duplicate entry|for key '|stack trace/);
}

// Feature: mini-operations-erp, Property 15: Every rejected request answers from the declared code table and changes nothing
describe('Property 15: Every rejected request answers from the declared code table and changes nothing', () => {
    // Every scenario below issues one real HTTP request plus a couple of direct database
    // reads, the same cost shape as the HTTP-driven properties in the other *.pbt.test.js
    // files, so each test uses the Req 12.7 floor.
    const RUNS_PROPERTY_15 = { numRuns: 25 };

    test('an unknown-but-well-formed reference on POST /api/inventory is rejected 400 INVALID_REFERENCE and creates no record', async () => {
        const adminToken = await tokenFor('Admin');
        let counter = 0;

        await fc.assert(
            fc.asyncProperty(genUnusedObjectId, async (unknownLocationId) => {
                const before = await InventoryRecord.find({}).sort({ _id: 1 }).lean();

                const response = await agent()
                    .post('/api/inventory')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({
                        item: FIXTURE_ITEMS.widget.id,
                        location: unknownLocationId,
                        batch: `PROP15-REF-${counter++}`,
                        physicalQuantity: 10,
                        movementReference: `prop15-ref-${counter++}`,
                    });

                expect(response.status).toBe(ERROR_CODES.INVALID_REFERENCE);
                expect(response.body.code).toBe('INVALID_REFERENCE');
                assertCleanMessage(response.body.message);

                expect(await InventoryRecord.find({}).sort({ _id: 1 }).lean()).toEqual(before);
            }),
            RUNS_PROPERTY_15
        );
    });

    test('a malformed id on PATCH /api/work-orders/:id/status is rejected 400 INVALID_IDENTIFIER and changes no work order', async () => {
        const adminToken = await tokenFor('Admin');
        // The empty-string case of genMalformedId collapses the URL path segment before
        // it ever reaches the Validation_Layer (Express does not match an empty `:id`
        // segment), so it is excluded here: every remaining case still exercises every
        // distinct way an id fails the 24-hex-character check.
        const genPathMalformedId = genMalformedId.filter((id) => id.length > 0);

        await fc.assert(
            fc.asyncProperty(genPathMalformedId, async (malformedId) => {
                const before = await WorkOrder.find({}).sort({ _id: 1 }).lean();

                const response = await agent()
                    .patch(`/api/work-orders/${encodeURIComponent(malformedId)}/status`)
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({ status: 'InProgress' });

                expect(response.status).toBe(ERROR_CODES.INVALID_IDENTIFIER);
                expect(response.body.code).toBe('INVALID_IDENTIFIER');
                assertCleanMessage(response.body.message);

                expect(await WorkOrder.find({}).sort({ _id: 1 }).lean()).toEqual(before);
            }),
            RUNS_PROPERTY_15
        );
    });

    test('an unknown body field on POST /api/transfers is rejected 400 VALIDATION_ERROR naming that field, and creates no transfer', async () => {
        const adminToken = await tokenFor('Admin');
        const TRANSFER_FIELDS = ['item', 'batch', 'sourceLocation', 'destinationLocation', 'quantity'];
        const genUnknownField = fc
            .string({ minLength: 1, maxLength: 20 })
            .map((s) => s.replace(/[^a-zA-Z0-9]/g, '') || 'extraField')
            .filter((field) => !TRANSFER_FIELDS.includes(field));

        await fc.assert(
            fc.asyncProperty(genUnknownField, async (field) => {
                const before = await InternalTransfer.find({}).sort({ _id: 1 }).lean();

                const response = await agent()
                    .post('/api/transfers')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({
                        item: FIXTURE_ITEMS.widget.id,
                        batch: FIXTURE_INVENTORY_RECORDS.widgetMainBatchA.batch,
                        sourceLocation: FIXTURE_LOCATIONS.main.id,
                        destinationLocation: FIXTURE_LOCATIONS.secondary.id,
                        quantity: 5,
                        [field]: 'unexpected-value',
                    });

                expect(response.status).toBe(ERROR_CODES.VALIDATION_ERROR);
                expect(response.body.code).toBe('VALIDATION_ERROR');
                expect(response.body.details.length).toBeGreaterThanOrEqual(1);
                expect(response.body.details.some((entry) => entry.field === field)).toBe(true);
                assertCleanMessage(response.body.message);

                expect(await InternalTransfer.find({}).sort({ _id: 1 }).lean()).toEqual(before);
            }),
            RUNS_PROPERTY_15
        );
    });

    test('a malformed JSON body on POST /api/orders is rejected 400 MALFORMED_JSON and creates no order', async () => {
        const adminToken = await tokenFor('Admin');
        // Never closed, so express.json() always fails to parse it, whatever content
        // fast-check draws for the customer name.
        const genBrokenJson = fc
            .string({ minLength: 1, maxLength: 40 })
            .map((s) => `{"customerName": "${s.replace(/["\\]/g, '')}`);

        await fc.assert(
            fc.asyncProperty(genBrokenJson, async (brokenBody) => {
                const before = await CustomerOrder.find({}).sort({ _id: 1 }).lean();

                const response = await agent()
                    .post('/api/orders')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .set('Content-Type', 'application/json')
                    .send(brokenBody);

                expect(response.status).toBe(ERROR_CODES.MALFORMED_JSON);
                expect(response.body.code).toBe('MALFORMED_JSON');
                assertCleanMessage(response.body.message);

                expect(await CustomerOrder.find({}).sort({ _id: 1 }).lean()).toEqual(before);
            }),
            RUNS_PROPERTY_15
        );
    });

    test('an unmatched path and method is rejected 404 ROUTE_NOT_FOUND without touching any collection', async () => {
        const genUnmatchedPath = fc
            .string({ minLength: 1, maxLength: 20 })
            .map((s) => s.replace(/[^a-zA-Z0-9-]/g, '') || 'nowhere')
            .map((segment) => `/api/${segment}-prop15-does-not-exist`);

        await fc.assert(
            fc.asyncProperty(genUnmatchedPath, async (path) => {
                const [ordersBefore, transfersBefore, workOrdersBefore, recordsBefore] = await Promise.all([
                    CustomerOrder.countDocuments({}),
                    InternalTransfer.countDocuments({}),
                    WorkOrder.countDocuments({}),
                    InventoryRecord.countDocuments({}),
                ]);

                const response = await agent().get(path);

                expect(response.status).toBe(ERROR_CODES.ROUTE_NOT_FOUND);
                expect(response.body.code).toBe('ROUTE_NOT_FOUND');
                assertCleanMessage(response.body.message);

                expect(await CustomerOrder.countDocuments({})).toBe(ordersBefore);
                expect(await InternalTransfer.countDocuments({})).toBe(transfersBefore);
                expect(await WorkOrder.countDocuments({})).toBe(workOrdersBefore);
                expect(await InventoryRecord.countDocuments({})).toBe(recordsBefore);
            }),
            RUNS_PROPERTY_15
        );
    });
});

// Feature: mini-operations-erp, Property 16: Authentication and role enforcement hold across the route table
describe('Property 16: Authentication and role enforcement hold across the route table', () => {
    // Stub routes, no database write on any rejection this half exercises. Kept at exactly
    // the numRuns: 25 floor of Req 12.7 for suite speed.
    const RUNS_PROPERTY_16_TOKEN_STATES = { numRuns: 25 };
    // Drives real HTTP requests against real routes and real documents. Kept at exactly the
    // numRuns: 25 floor of Req 12.7 for suite speed.
    const RUNS_PROPERTY_16_ROLE_ENFORCEMENT = { numRuns: 25 };
    const RUNS_PROPERTY_16_LOGIN = { numRuns: 25 };

    const FOREIGN_SECRET = 'a-completely-different-secret-of-at-least-32-chars';

    // Every route this half exercises: the full write route table, the stub read route,
    // and the deliberately unmapped write route -- so an unidentified token is rejected
    // the same way regardless of which route it was aimed at, without re-enumerating the
    // hand-written role x route matrix tests/authorization.test.js already covers.
    const ALL_STUB_ROUTES = [...Object.keys(WRITE_ROUTE_PERMISSIONS), READ_ROUTE, UNMAPPED_WRITE_ROUTE];

    const genTokenState = fc.oneof(
        fc.constant({ kind: 'absent' }),
        fc.constant({ kind: 'malformed' }),
        genRole.map((role) => ({ kind: 'foreignSignature', role })),
        genRole.map((role) => ({ kind: 'expired', role }))
    );

    function buildToken(tokenState) {
        if (tokenState.kind === 'absent') return undefined;
        if (tokenState.kind === 'malformed') return 'not-a-real-jwt-token';
        if (tokenState.kind === 'foreignSignature') {
            return jwt.sign({ sub: FIXTURE_USERS.Admin.id, role: tokenState.role }, FOREIGN_SECRET, {
                expiresIn: '8h',
            });
        }
        // expired
        return jwt.sign({ sub: FIXTURE_USERS.Admin.id, role: tokenState.role }, config.jwtSecret, {
            expiresIn: '-10s',
        });
    }

    test('an absent, malformed, foreign-signature, or expired token is rejected 401 UNAUTHENTICATED on any route, for any role the token might have carried', async () => {
        await fc.assert(
            fc.asyncProperty(fc.constantFrom(...ALL_STUB_ROUTES), genTokenState, async (route, tokenState) => {
                const token = buildToken(tokenState);

                const response = await callRoute(route, token);

                expect(response.status).toBe(401);
                expect(response.body).toEqual({ code: 'UNAUTHENTICATED', message: expect.any(String) });
                // The route handler never ran, on a write route or a read route alike.
                expect(response.body).not.toHaveProperty('reached');
            }),
            RUNS_PROPERTY_16_TOKEN_STATES
        );
    });

    // The real routes driven for the role-enforcement half: one write route each role set
    // permits differently, plus the read route every valid role passes. Real routes and
    // real documents (rather than the stub app) is what the hand-written matrix in
    // tests/authorization.test.js does not cover for this property.
    const genRoleCase = fc.constantFrom(
        {
            type: 'write',
            method: 'post',
            path: () => `/api/inventory/${FIXTURE_INVENTORY_RECORDS.widgetMainBatchB.id}/adjust`,
            body: () => ({
                direction: 'IN',
                quantity: 1,
                movementReference: `prop16-adjust-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            }),
            permission: WRITE_ROUTE_PERMISSIONS['POST /api/inventory/:id/adjust'],
            successStatus: 200,
        },
        {
            type: 'write',
            method: 'post',
            path: () => '/api/orders',
            // FIXTURE_LOCATIONS.main is where the fixture's widget records carry spare
            // availability (Req 12.11), so a permitted role's request always succeeds
            // rather than colliding with Req 7.3's own INSUFFICIENT_AVAILABLE_QUANTITY.
            body: () => ({
                customerName: 'Property 16 Customer',
                item: FIXTURE_ITEMS.widget.id,
                location: FIXTURE_LOCATIONS.main.id,
                quantity: 1,
            }),
            permission: WRITE_ROUTE_PERMISSIONS['POST /api/orders'],
            successStatus: 201,
        },
        {
            type: 'read',
            method: 'get',
            path: () => '/api/inventory',
            body: () => undefined,
            permission: null,
            successStatus: 200,
        }
    );

    test('a valid token passes a read route for any valid role, passes a write route exactly when the permission map names that role, and every denial leaves the targeted document unchanged', async () => {
        await fc.assert(
            fc.asyncProperty(genRoleCase, genRole, async (routeCase, role) => {
                const token = jwt.sign({ sub: FIXTURE_USERS.Admin.id, role }, config.jwtSecret, {
                    expiresIn: '8h',
                });

                const recordBefore =
                    routeCase.type === 'write'
                        ? await InventoryRecord.findById(FIXTURE_INVENTORY_RECORDS.widgetMainBatchB.id).lean()
                        : null;
                const ordersCountBefore = await CustomerOrder.countDocuments({});

                const pending = agent()[routeCase.method](routeCase.path()).set(
                    'Authorization',
                    `Bearer ${token}`
                );
                const body = routeCase.body();
                const response = body === undefined ? await pending : await pending.send(body);

                const isValidRole = ROLES.includes(role);
                const isPermittedWrite = routeCase.type === 'write' && routeCase.permission.includes(role);
                // A falsy role claim (the empty-string sample in genRole) is not one
                // authenticate.js will even pass through to authorize.js: it is treated as
                // no identity at all (Req 1.7, 1.9), so it is 401, never 403.
                const succeeds = role !== '' && isValidRole && (routeCase.type === 'read' || isPermittedWrite);

                if (succeeds) {
                    expect(response.status).toBe(routeCase.successStatus);
                } else if (role === '') {
                    expect(response.status).toBe(401);
                    expect(response.body).toEqual({ code: 'UNAUTHENTICATED', message: expect.any(String) });
                } else {
                    expect(response.status).toBe(403);
                    expect(response.body).toEqual({ code: 'FORBIDDEN', message: expect.any(String) });
                }

                if (routeCase.type === 'write' && !succeeds) {
                    const recordAfter = await InventoryRecord.findById(
                        FIXTURE_INVENTORY_RECORDS.widgetMainBatchB.id
                    ).lean();
                    expect(recordAfter).toEqual(recordBefore);
                    expect(await CustomerOrder.countDocuments({})).toBe(ordersCountBefore);
                }
            }),
            RUNS_PROPERTY_16_ROLE_ENFORCEMENT
        );
    });

    test('an unmatched email and a wrong password produce an identical rejection for arbitrary inputs', async () => {
        const admin = FIXTURE_USERS.Admin;
        const genEmail = fc
            .string({ minLength: 1, maxLength: 30 })
            .map((s) => `${s.replace(/[^a-zA-Z0-9]/g, '') || 'x'}-prop16@fixture.test`)
            .filter((email) => !Object.values(FIXTURE_USERS).some((user) => user.email === email));
        const genPassword = fc
            .string({ minLength: 1, maxLength: 72 })
            .filter((pw) => pw.trim().length >= 1 && pw !== admin.password);

        await fc.assert(
            fc.asyncProperty(genEmail, genPassword, async (email, password) => {
                const unknownEmail = await agent()
                    .post('/api/auth/login')
                    .send({ email, password: admin.password });
                const wrongPassword = await agent()
                    .post('/api/auth/login')
                    .send({ email: admin.email, password });

                expect(unknownEmail.status).toBe(401);
                expect(unknownEmail.body).toEqual({
                    code: 'INVALID_CREDENTIALS',
                    message: expect.any(String),
                });
                expect(wrongPassword.status).toBe(unknownEmail.status);
                expect(wrongPassword.body).toEqual(unknownEmail.body);
            }),
            RUNS_PROPERTY_16_LOGIN
        );
    });
});

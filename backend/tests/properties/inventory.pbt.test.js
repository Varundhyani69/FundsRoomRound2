// backend/tests/properties/inventory.pbt.test.js -- property-based tests for the
// inventory core: derived availability, invariants, record identity, ledger
// reconstruction, movement-reference idempotency, rejected-movement totality, and
// invalid-quantity rejection (design.md Properties 1-7, Req 3, 4, 8).
//
// Conventions follow tests/properties/api.pbt.test.js: one top-level `describe` per
// numbered property, a `// Feature: ...` tag comment naming it, and a `// Validates:
// ...` comment matching design.md's wording. fast-check reports the failing seed and
// the shrunk counterexample on failure (Req 12.7).
//
// Properties 2-7 drive the real routes over HTTP through the exported app (design.md:
// "Property tests use the HTTP API for anything involving guards, transactions, or
// authorization"). Property 1 has none of those -- it is a pure read of the derived
// formula -- so it calls inventory.service.js and the model directly, which is both
// faster and closer to "the single source of truth" the property is about.
//
// ISOLATION ACROSS ITERATIONS: dbSetup.js's `beforeEach` resets the whole database and
// reloads the fixture once per `test()`, not once per fast-check run. Every property
// below therefore creates a brand-new Item per iteration (see `createFreshItem`) so
// each run's records are scoped to an Item nothing else can see, instead of hand-rolling
// a delete between runs.
//
// PERFORMANCE: every property below uses exactly the numRuns: 25 floor of Req 12.7, the
// minimum that still satisfies the requirement, so the suite runs as fast as possible.
// Properties 2 and 4 additionally replay sequences of up to 20 operations per run, which is
// the most expensive shape in this file, so they keep the longer per-test timeout even
// though their run count is the same as every other property here.

const crypto = require('crypto');
const fc = require('fast-check');

const Item = require('../../src/models/Item');
const InventoryRecord = require('../../src/models/InventoryRecord');
const InventoryTransaction = require('../../src/models/InventoryTransaction');
const inventoryService = require('../../src/services/inventory.service');
const { adjustMovementReference } = require('../../src/services/movementReference');
const { withTransaction } = require('../../src/db/withTransaction');
const { agent } = require('../setup/agent');
const { FIXTURE_LOCATIONS, FIXTURE_CATEGORIES, tokenFor } = require('../setup/seedFixture');
const { genQuantity, genInvalidQuantity, genBatch, genRecordLayout, genOperationSequence } =
    require('../setup/generators');

const RUNS_PROPERTY_1 = { numRuns: 25 };
const RUNS_PROPERTY_2 = { numRuns: 25 }; // sequences of up to 20 HTTP-driven operations
const RUNS_PROPERTY_3 = { numRuns: 25 };
const RUNS_PROPERTY_4 = { numRuns: 25 }; // same cost shape as Property 2
const RUNS_PROPERTY_5 = { numRuns: 25 };
const RUNS_PROPERTY_6 = { numRuns: 25 };
const RUNS_PROPERTY_7 = { numRuns: 25 };

// A long timeout for the two sequence-driven properties: each run issues up to 20 real
// HTTP requests against the in-memory replica set, and fast-check repeats that `numRuns`
// times inside a single Jest `test()`.
const SEQUENCE_TEST_TIMEOUT = 120000;

// A location every property below can reuse. The fixture only seeds records for
// `widget`/`gadget` at this pair; a fresh Item per iteration (see below) is what keeps
// every property's records from colliding with the fixture's or with each other, so
// reusing one Location here is safe.
const LOCATION_ID = FIXTURE_LOCATIONS.secondary.id;

/**
 * A brand-new Item, so one property-test iteration's InventoryRecords can never be
 * confused with the fixture's or with another iteration's. Cheaper than deleting
 * documents between fast-check runs, and it is what lets Location_Available_Quantity
 * reads stay scoped to exactly the records one iteration created.
 *
 * @returns {Promise<string>} the new Item's id
 */
async function createFreshItem() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const item = await Item.create({
        code: `PBT-${suffix}`,
        name: `Property test item ${suffix}`,
        category: FIXTURE_CATEGORIES.rawMaterial.id,
    });
    return String(item._id);
}

/**
 * Replays one `genOperationSequence` sequence against a single Item/Location over HTTP,
 * calling `onAfterAccepted` after every operation the API actually accepts. Shared by
 * Property 2 and Property 4, which differ only in what they check after each accepted
 * step.
 *
 * `adjustIn`/`adjustOut` always target the first record the sequence created (there is
 * no "current record" concept in the generator), and are skipped -- not accepted -- when
 * no record exists yet. A `createRecord` whose batch collides with an earlier one in the
 * same sequence is rejected 409 by the real duplicate-triple guard and is likewise just
 * not accepted; the sequence keeps going.
 *
 * @param {Array<object>} ops one `genOperationSequence` sequence
 * @param {{ item: string, location: string, token: string, refPrefix: string, onAfterAccepted: (item: string) => Promise<void> }} options
 */
async function runOperationSequence(ops, { item, location, token, refPrefix, onAfterAccepted }) {
    const recordIds = [];
    let step = 0;

    for (const op of ops) {
        let accepted = false;

        if (op.type === 'createRecord') {
            const response = await agent()
                .post('/api/inventory')
                .set('Authorization', `Bearer ${token}`)
                .send({
                    item,
                    location,
                    batch: op.batch,
                    physicalQuantity: op.physicalQuantity,
                    movementReference: `${refPrefix}-create-${step++}`,
                });
            if (response.status === 201) {
                recordIds.push(response.body.id);
                accepted = true;
            }
        } else if (recordIds.length > 0) {
            // adjustIn / adjustOut, targeting the first record this sequence created.
            const response = await agent()
                .post(`/api/inventory/${recordIds[0]}/adjust`)
                .set('Authorization', `Bearer ${token}`)
                .send({
                    direction: op.type === 'adjustIn' ? 'IN' : 'OUT',
                    quantity: op.quantity,
                    movementReference: `${refPrefix}-adjust-${step++}`,
                });
            accepted = response.status === 200;
        }

        if (accepted) {
            await onAfterAccepted(item);
        }
    }
}

// Feature: mini-operations-erp, Property 1: Available quantity is always the derived difference
describe('Property 1: Available quantity is always the derived difference', () => {
    test('every record reports physicalQuantity - reservedQuantity, and the location sum matches', async () => {
        await fc.assert(
            fc.asyncProperty(genRecordLayout, async (layout) => {
                const item = await createFreshItem();

                if (layout.length > 0) {
                    await InventoryRecord.create(
                        layout.map(({ batch, physicalQuantity, reservedQuantity }) => ({
                            item,
                            location: LOCATION_ID,
                            batch,
                            physicalQuantity,
                            reservedQuantity,
                        }))
                    );
                }

                // Every read path: the list read (which is what a controller serializes
                // through the `availableQuantity` virtual) and the dedicated
                // Location_Available_Quantity read.
                const records = await inventoryService.listInventoryRecords({
                    item,
                    location: LOCATION_ID,
                });
                expect(records).toHaveLength(layout.length);
                for (const record of records) {
                    expect(record.availableQuantity).toBe(
                        record.physicalQuantity - record.reservedQuantity
                    );
                }

                const { locationAvailableQuantity: reported } =
                    await inventoryService.getLocationAvailability({ item, location: LOCATION_ID });
                const expectedSum = layout.reduce(
                    (total, record) => total + (record.physicalQuantity - record.reservedQuantity),
                    0
                );
                expect(reported).toBe(expectedSum); // 0 for an empty layout
            }),
            RUNS_PROPERTY_1
        );
    });
});

// Feature: mini-operations-erp, Property 2: Inventory invariants survive every accepted operation
describe('Property 2: Inventory invariants survive every accepted operation', () => {
    test(
        'every accepted operation leaves every record with legal physical/reserved quantities',
        async () => {
            const adminToken = await tokenFor('Admin');
            let counter = 0;

            await fc.assert(
                fc.asyncProperty(genOperationSequence, async (ops) => {
                    const item = await createFreshItem();

                    await runOperationSequence(ops, {
                        item,
                        location: LOCATION_ID,
                        token: adminToken,
                        refPrefix: `PROP2-${counter++}`,
                        onAfterAccepted: async () => {
                            const records = await InventoryRecord.find({ item }).lean();
                            for (const record of records) {
                                expect(record.physicalQuantity).toBeGreaterThanOrEqual(0);
                                expect(record.reservedQuantity).toBeGreaterThanOrEqual(0);
                                expect(record.reservedQuantity).toBeLessThanOrEqual(
                                    record.physicalQuantity
                                );
                            }
                        },
                    });
                }),
                RUNS_PROPERTY_2
            );
        },
        SEQUENCE_TEST_TIMEOUT
    );
});

// Feature: mini-operations-erp, Property 3: Item, location, and batch identify at most one record
describe('Property 3: Item, location, and batch identify at most one record', () => {
    test('a duplicate triple, including a whitespace-only variant, is rejected and existing records stay unchanged', async () => {
        let counter = 0;
        const adminToken = await tokenFor('Admin');

        await fc.assert(
            fc.asyncProperty(genBatch, genQuantity, genQuantity, async (rawBatch, firstQty, secondQty) => {
                const item = await createFreshItem();

                const first = await agent()
                    .post('/api/inventory')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({
                        item,
                        location: LOCATION_ID,
                        batch: rawBatch,
                        physicalQuantity: firstQty,
                        movementReference: `PROP3-first-${counter++}`,
                    });
                expect(first.status).toBe(201);

                const before = await InventoryRecord.find({ item }).sort({ _id: 1 }).lean();

                // Differs from the first request only by leading/trailing whitespace
                // around the same trimmed batch identity (Req 3.6).
                const paddedBatch = `  ${rawBatch.trim()}\t`;
                const second = await agent()
                    .post('/api/inventory')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({
                        item,
                        location: LOCATION_ID,
                        batch: paddedBatch,
                        physicalQuantity: secondQty,
                        movementReference: `PROP3-second-${counter++}`,
                    });

                expect(second.status).toBe(409);
                expect(second.body).toEqual({
                    code: 'DUPLICATE_INVENTORY_RECORD',
                    message: expect.any(String),
                });

                const after = await InventoryRecord.find({ item }).sort({ _id: 1 }).lean();
                expect(after).toEqual(before);
            }),
            RUNS_PROPERTY_3
        );
    });
});

// Feature: mini-operations-erp, Property 4: The ledger reconstructs the balances
describe('Property 4: The ledger reconstructs the balances', () => {
    test(
        "every record's stored quantities equal the sum of its own ledger deltas after every accepted operation",
        async () => {
            const adminToken = await tokenFor('Admin');
            let counter = 0;

            await fc.assert(
                fc.asyncProperty(genOperationSequence, async (ops) => {
                    const item = await createFreshItem();

                    await runOperationSequence(ops, {
                        item,
                        location: LOCATION_ID,
                        token: adminToken,
                        refPrefix: `PROP4-${counter++}`,
                        onAfterAccepted: async () => {
                            const records = await InventoryRecord.find({ item }).lean();
                            for (const record of records) {
                                const rows = await InventoryTransaction.find({
                                    inventoryRecord: record._id,
                                }).lean();
                                const physicalFromLedger = rows.reduce(
                                    (total, row) => total + row.physicalDelta,
                                    0
                                );
                                const reservedFromLedger = rows.reduce(
                                    (total, row) => total + row.reservedDelta,
                                    0
                                );
                                expect(record.physicalQuantity).toBe(physicalFromLedger);
                                expect(record.reservedQuantity).toBe(reservedFromLedger);
                            }
                        },
                    });
                }),
                RUNS_PROPERTY_4
            );
        },
        SEQUENCE_TEST_TIMEOUT
    );
});

// Feature: mini-operations-erp, Property 5: A movement reference can be applied at most once
describe('Property 5: A movement reference can be applied at most once', () => {
    test('only the first of k repeated submissions is accepted, and the rest are rejected as duplicates', async () => {
        let counter = 0;
        const adminToken = await tokenFor('Admin');

        // "reference strings" per design.md's generator list for this property; not a
        // shared generator because no other property needs an arbitrary reference body.
        const genReferenceSuffix = fc
            .string({ minLength: 1, maxLength: 40 })
            .filter((value) => value.trim().length >= 1);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 2, max: 5 }),
                genQuantity,
                genReferenceSuffix,
                async (repeatCount, quantity, refSuffix) => {
                    const item = await createFreshItem();

                    const createRes = await agent()
                        .post('/api/inventory')
                        .set('Authorization', `Bearer ${adminToken}`)
                        .send({
                            item,
                            location: LOCATION_ID,
                            batch: 'PROP5',
                            physicalQuantity: 0,
                            movementReference: `PROP5-open-${counter++}`,
                        });
                    expect(createRes.status).toBe(201);
                    const recordId = createRes.body.id;

                    // Trimmed here to match exactly what the server stores after its own
                    // trim, so the movementReference lookup below finds the same string.
                    const movementReference = `PROP5-adjust-${counter++}-${refSuffix}`.trim();

                    const responses = [];
                    for (let i = 0; i < repeatCount; i += 1) {
                        responses.push(
                            // eslint-disable-next-line no-await-in-loop -- k repeats of
                            // the SAME movement must be submitted one after another to
                            // test idempotency, not concurrency (that is Property 13).
                            await agent()
                                .post(`/api/inventory/${recordId}/adjust`)
                                .set('Authorization', `Bearer ${adminToken}`)
                                .send({ direction: 'IN', quantity, movementReference })
                        );
                    }

                    const accepted = responses.filter((response) => response.status === 200);
                    const rejected = responses.filter((response) => response.status === 409);
                    expect(accepted).toHaveLength(1);
                    expect(rejected).toHaveLength(repeatCount - 1);
                    for (const response of rejected) {
                        expect(response.body.code).toBe('DUPLICATE_INVENTORY_TRANSACTION');
                    }

                    const ledgerRows = await InventoryTransaction.find({
                        movementReference: adjustMovementReference(recordId, movementReference),
                    }).lean();
                    expect(ledgerRows).toHaveLength(1);

                    const finalRecord = await InventoryRecord.findById(recordId).lean();
                    expect(finalRecord.physicalQuantity).toBe(quantity);
                    expect(finalRecord.reservedQuantity).toBe(0);
                }
            ),
            RUNS_PROPERTY_5
        );
    });
});

// Feature: mini-operations-erp, Property 6: Rejected movements leave the world untouched
describe('Property 6: Rejected movements leave the world untouched', () => {
    /** Every InventoryRecord field and every ledger row for one record, for a before/after comparison. */
    async function snapshot(recordId) {
        return {
            record: await InventoryRecord.findById(recordId).lean(),
            ledger: await InventoryTransaction.find({ inventoryRecord: recordId })
                .sort({ _id: 1 })
                .lean(),
        };
    }

    test('an OUT beyond the physical quantity is rejected 409 INSUFFICIENT_PHYSICAL_QUANTITY and changes nothing', async () => {
        let counter = 0;
        const adminToken = await tokenFor('Admin');

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 0, max: 1000 }),
                fc.integer({ min: 1, max: 1000 }),
                async (physicalQuantity, overflow) => {
                    const item = await createFreshItem();

                    const createRes = await agent()
                        .post('/api/inventory')
                        .set('Authorization', `Bearer ${adminToken}`)
                        .send({
                            item,
                            location: LOCATION_ID,
                            batch: 'PROP6A',
                            physicalQuantity,
                            movementReference: `PROP6A-open-${counter++}`,
                        });
                    expect(createRes.status).toBe(201);
                    const recordId = createRes.body.id;

                    const before = await snapshot(recordId);

                    const response = await agent()
                        .post(`/api/inventory/${recordId}/adjust`)
                        .set('Authorization', `Bearer ${adminToken}`)
                        .send({
                            direction: 'OUT',
                            quantity: physicalQuantity + overflow, // always drives physical below 0
                            movementReference: `PROP6A-adjust-${counter++}`,
                        });

                    expect(response.status).toBe(409);
                    expect(response.body.code).toBe('INSUFFICIENT_PHYSICAL_QUANTITY');

                    expect(await snapshot(recordId)).toEqual(before);
                }
            ),
            RUNS_PROPERTY_6
        );
    });

    test('a reservation above physical quantity via applyMovement directly is rejected 409 INSUFFICIENT_AVAILABLE_QUANTITY and changes nothing', async () => {
        let counter = 0;

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 0, max: 1000 }),
                fc.integer({ min: 1, max: 1000 }),
                async (physicalQuantity, overflow) => {
                    const item = await createFreshItem();

                    // adjustInventoryRecord only exposes IN/OUT physical moves, so the
                    // reserved-above-physical case is driven straight through
                    // applyMovement, the one function that writes both the record and
                    // its ledger row (design.md's own note for this property).
                    const record = await InventoryRecord.create({
                        item,
                        location: LOCATION_ID,
                        batch: 'PROP6B',
                        physicalQuantity,
                        reservedQuantity: 0,
                    });

                    const before = await snapshot(record._id);

                    let caught;
                    try {
                        await withTransaction((session) =>
                            inventoryService.applyMovement(
                                record._id,
                                {
                                    physicalDelta: 0,
                                    reservedDelta: physicalQuantity + overflow, // always exceeds physical
                                    movementReference: `PROP6B-${counter++}`,
                                },
                                session
                            )
                        );
                    } catch (error) {
                        caught = error;
                    }

                    expect(caught).toBeDefined();
                    expect(caught.status).toBe(409);
                    expect(caught.code).toBe('INSUFFICIENT_AVAILABLE_QUANTITY');

                    expect(await snapshot(record._id)).toEqual(before);
                }
            ),
            RUNS_PROPERTY_6
        );
    });
});

// Feature: mini-operations-erp, Property 7: Invalid quantities are rejected identically everywhere
describe('Property 7: Invalid quantities are rejected identically everywhere', () => {
    test('an invalid quantity on POST /api/inventory/:id/adjust is rejected 400 and changes nothing', async () => {
        let counter = 0;
        const adminToken = await tokenFor('Admin');

        await fc.assert(
            fc.asyncProperty(
                genInvalidQuantity,
                fc.constantFrom('IN', 'OUT'),
                async (invalidQuantity, direction) => {
                    const item = await createFreshItem();

                    const createRes = await agent()
                        .post('/api/inventory')
                        .set('Authorization', `Bearer ${adminToken}`)
                        .send({
                            item,
                            location: LOCATION_ID,
                            batch: 'PROP7',
                            physicalQuantity: 500,
                            movementReference: `PROP7-open-${counter++}`,
                        });
                    expect(createRes.status).toBe(201);
                    const recordId = createRes.body.id;

                    const before = {
                        record: await InventoryRecord.findById(recordId).lean(),
                        ledgerCount: await InventoryTransaction.countDocuments({
                            inventoryRecord: recordId,
                        }),
                    };

                    const body = { direction, movementReference: `PROP7-adjust-${counter++}` };
                    // genInvalidQuantity represents "absent" as `undefined`; the field
                    // must be genuinely missing from the wire body, not sent as the
                    // literal string "undefined".
                    if (invalidQuantity !== undefined) {
                        body.quantity = invalidQuantity;
                    }

                    const response = await agent()
                        .post(`/api/inventory/${recordId}/adjust`)
                        .set('Authorization', `Bearer ${adminToken}`)
                        .send(body);

                    expect(response.status).toBe(400);
                    // Req 4.1 gives an out-of-range/non-integer quantity INVALID_QUANTITY,
                    // but Req 4.8 explicitly carves out an OMITTED quantity as the plain
                    // VALIDATION_ERROR a missing required field ordinarily produces. The
                    // two requirements therefore name different codes for the "absent"
                    // case; this branch follows Req 4.8 for it and Req 4.1 for every
                    // other invalid value, rather than the single INVALID_QUANTITY code
                    // design.md's Property 7 prose states for "any invalid quantity".
                    const expectedCode =
                        invalidQuantity === undefined ? 'VALIDATION_ERROR' : 'INVALID_QUANTITY';
                    expect(response.body.code).toBe(expectedCode);

                    const after = {
                        record: await InventoryRecord.findById(recordId).lean(),
                        ledgerCount: await InventoryTransaction.countDocuments({
                            inventoryRecord: recordId,
                        }),
                    };
                    expect(after).toEqual(before);
                }
            ),
            RUNS_PROPERTY_7
        );
    });
});

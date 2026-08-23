// backend/tests/properties/workOrders.pbt.test.js -- property-based tests for the work
// order core: read-time derived shortage and the guarded status machine (design.md
// Properties 8-9, Req 5).
//
// Conventions follow tests/properties/inventory.pbt.test.js: one top-level `describe` per
// numbered property, a `// Feature: ...` tag comment naming it, a `// Validates: ...`
// comment matching design.md's wording, and a fresh Item per iteration (`createFreshItem`)
// so dbSetup.js's once-per-`test()` reset never has to be relied on between fast-check runs.
//
// SCOPE NOTE for Property 9: design.md's prose covers both the work order status machine
// (Assigned -> InProgress -> Completed) and the transfer status machine (Requested ->
// Dispatched -> Received). Transfers do not exist yet as of increment 6, so this file tests
// only the work order half; a later increment's transfer property test extends the same
// property for Requirements 6.5 and 6.10.

const crypto = require('crypto');
const { Item, InventoryRecord, WorkOrder } = require('../setup/tables');
const fc = require('fast-check');

const { locationAvailableQuantity } = require('../../src/services/availability');
const { agent } = require('../setup/agent');
const { FIXTURE_LOCATIONS, FIXTURE_CATEGORIES, FIXTURE_USERS, tokenFor } =
    require('../setup/seedFixture');
const { genQuantity, genRecordLayout } = require('../setup/generators');

// Both properties drive the real routes over HTTP through the exported app, the same
// reason Properties 2-7 in inventory.pbt.test.js do: everything here involves the
// validation layer, the authorize map, or the status/shortage guards actually living in
// workOrder.service.js. Both use exactly the numRuns: 25 floor of Req 12.7 for speed.
const RUNS_PROPERTY_8 = { numRuns: 25 };
// A finite space of 9 valid current/target pairs plus 6 out-of-enum-target pairs (15
// concrete cases total, built below). 25 runs of random draws from fc.constantFrom still
// gives every case a strong chance of being exercised at least once, without needing to
// enumerate them with a non-property test.
const RUNS_PROPERTY_9 = { numRuns: 25 };

// A location every property below can reuse. The fixture only seeds Inventory_Records for
// widget/gadget at `main`; a fresh Item per iteration (see below) is what keeps every
// property's records from colliding with the fixture's or with another iteration's, so
// reusing one Location here is safe.
const LOCATION_ID = FIXTURE_LOCATIONS.secondary.id;

/**
 * A brand-new Item, so one property-test iteration's Work_Order and Inventory_Records can
 * never be confused with the fixture's or with another iteration's. Same rationale and
 * shape as inventory.pbt.test.js's `createFreshItem`.
 *
 * @returns {Promise<string>} the new Item's id
 */
async function createFreshItem() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const item = await Item.create({
        code: `PBT-WO-${suffix}`,
        name: `Work order property test item ${suffix}`,
        category: FIXTURE_CATEGORIES.rawMaterial.id,
    });
    return String(item._id);
}

// Feature: mini-operations-erp, Property 8: Work order shortage is derived and bounded
describe('Property 8: Work order shortage is derived and bounded', () => {
    test('shortageQuantity equals max(0, required - available), stays bounded, and tracks a later inventory change', async () => {
        const adminToken = await tokenFor('Admin');
        let counter = 0;

        await fc.assert(
            fc.asyncProperty(genQuantity, genRecordLayout, genQuantity, async (requiredQuantity, layout, delta) => {
                const item = await createFreshItem();

                // An anchor record with zero physical/reserved quantity, so there is
                // always exactly one record this iteration can adjust through
                // POST /api/inventory/:id/adjust, whether or not the generated layout
                // itself is empty. Its batch is unique per iteration so it cannot collide
                // with a batch genRecordLayout happens to generate.
                const anchorBatch = `PROP8-ANCHOR-${counter++}`;
                await InventoryRecord.create([
                    ...layout.map(({ batch, physicalQuantity, reservedQuantity }) => ({
                        item,
                        location: LOCATION_ID,
                        batch,
                        physicalQuantity,
                        reservedQuantity,
                    })),
                    { item, location: LOCATION_ID, batch: anchorBatch, physicalQuantity: 0, reservedQuantity: 0 },
                ]);

                const createRes = await agent()
                    .post('/api/work-orders')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({
                        location: LOCATION_ID,
                        item,
                        requiredQuantity,
                        assignedUser: FIXTURE_USERS.OperationsUser.id,
                    });
                expect(createRes.status).toBe(201);
                const workOrderId = createRes.body.id;

                // Recomputed independently from the records current at this read, the
                // same "single source of truth" module the service itself uses, rather
                // than re-deriving the formula by hand in the test.
                const recordsBefore = await InventoryRecord.find({ item, location: LOCATION_ID }).lean();
                const availableBefore = locationAvailableQuantity(recordsBefore);
                const expectedShortageBefore = Math.max(0, requiredQuantity - availableBefore);

                expect(createRes.body.locationAvailableQuantity).toBe(availableBefore);
                expect(createRes.body.shortageQuantity).toBe(expectedShortageBefore);
                expect(createRes.body.shortageQuantity).toBeGreaterThanOrEqual(0);
                expect(createRes.body.shortageQuantity).toBeLessThanOrEqual(requiredQuantity);

                // Change inventory between the two reads: adjust the anchor record IN by
                // `delta`, which always raises Location_Available_Quantity by exactly
                // `delta` since the anchor starts at physical 0 / reserved 0.
                const anchorRecord = await InventoryRecord.findOne({ item, location: LOCATION_ID, batch: anchorBatch }).lean();
                const adjustRes = await agent()
                    .post(`/api/inventory/${anchorRecord._id}/adjust`)
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({
                        direction: 'IN',
                        quantity: delta,
                        movementReference: `PROP8-adjust-${counter++}`,
                    });
                expect(adjustRes.status).toBe(200);

                const recordsAfter = await InventoryRecord.find({ item, location: LOCATION_ID }).lean();
                const availableAfter = locationAvailableQuantity(recordsAfter);
                const expectedShortageAfter = Math.max(0, requiredQuantity - availableAfter);
                expect(availableAfter).toBe(availableBefore + delta);

                const getRes = await agent()
                    .get(`/api/work-orders/${workOrderId}`)
                    .set('Authorization', `Bearer ${adminToken}`);
                expect(getRes.status).toBe(200);
                expect(getRes.body.locationAvailableQuantity).toBe(availableAfter);
                expect(getRes.body.shortageQuantity).toBe(expectedShortageAfter);
                expect(getRes.body.shortageQuantity).toBeGreaterThanOrEqual(0);
                expect(getRes.body.shortageQuantity).toBeLessThanOrEqual(requiredQuantity);
            }),
            RUNS_PROPERTY_8
        );
    });
});

// Feature: mini-operations-erp, Property 9: A status change is accepted exactly when it is
// the successor (work order half only -- see the scope note at the top of this file)
describe('Property 9: A status change is accepted exactly when it is the successor', () => {
    const STATUSES = ['Assigned', 'InProgress', 'Completed'];

    // The one legal-successor rule, mirrored from workOrder.service.js's own
    // `LEGAL_SUCCESSOR` table so the test expresses the same rule independently rather than
    // importing the guard under test.
    const LEGAL_SUCCESSOR = { Assigned: 'InProgress', InProgress: 'Completed' };

    // A couple of concrete out-of-enum target strings: a plausible extra status and a
    // wrong-case near-miss of a real one.
    const OUT_OF_ENUM_TARGETS = ['Cancelled', 'assigned'];

    // The full cross product of {Assigned, InProgress, Completed} x itself (9 cases),
    // plus every starting status paired with each out-of-enum target (6 cases): 15
    // concrete cases in total, built once so fc.constantFrom draws from an exhaustive,
    // hand-verifiable list rather than a combinator that could silently drop a pair.
    const VALID_TARGET_CASES = STATUSES.flatMap((currentStatus) =>
        STATUSES.map((targetStatus) => ({ currentStatus, targetStatus, outOfEnum: false }))
    );
    const OUT_OF_ENUM_CASES = STATUSES.flatMap((currentStatus) =>
        OUT_OF_ENUM_TARGETS.map((targetStatus) => ({ currentStatus, targetStatus, outOfEnum: true }))
    );
    const ALL_CASES = [...VALID_TARGET_CASES, ...OUT_OF_ENUM_CASES];

    test('the change is accepted only when the target is the immediate successor of the current status; every other pair is rejected and leaves the work order unchanged', async () => {
        const adminToken = await tokenFor('Admin');

        const patchStatus = (id, status) =>
            agent()
                .patch(`/api/work-orders/${id}/status`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ status });

        await fc.assert(
            fc.asyncProperty(fc.constantFrom(...ALL_CASES), async ({ currentStatus, targetStatus, outOfEnum }) => {
                const item = await createFreshItem();
                const created = await agent()
                    .post('/api/work-orders')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({
                        location: LOCATION_ID,
                        item,
                        requiredQuantity: 1,
                        assignedUser: FIXTURE_USERS.OperationsUser.id,
                    });
                expect(created.status).toBe(201);
                const id = created.body.id;

                // Drive the work order to `currentStatus` via the one legal path, before
                // attempting the transition actually under test.
                if (currentStatus === 'InProgress' || currentStatus === 'Completed') {
                    const toInProgress = await patchStatus(id, 'InProgress');
                    expect(toInProgress.status).toBe(200);
                }
                if (currentStatus === 'Completed') {
                    const toCompleted = await patchStatus(id, 'Completed');
                    expect(toCompleted.status).toBe(200);
                }

                const before = await WorkOrder.findById(id).lean();
                expect(before.status).toBe(currentStatus);

                const isLegalSuccessor = !outOfEnum && LEGAL_SUCCESSOR[currentStatus] === targetStatus;

                const response = await patchStatus(id, targetStatus);

                if (isLegalSuccessor) {
                    expect(response.status).toBe(200);
                    expect(response.body.status).toBe(targetStatus);
                    expect(response.body.statusChangedAt).not.toBeNull();
                } else if (outOfEnum) {
                    expect(response.status).toBe(400);
                    expect(response.body.code).toBe('VALIDATION_ERROR');
                } else {
                    expect(response.status).toBe(409);
                    expect(response.body.code).toBe('INVALID_STATUS_TRANSITION');
                }

                const after = await WorkOrder.findById(id).lean();
                if (isLegalSuccessor) {
                    expect(after.status).toBe(targetStatus);
                } else {
                    expect(after.status).toBe(before.status);
                    expect(after.statusChangedAt).toEqual(before.statusChangedAt);
                }
            }),
            RUNS_PROPERTY_9
        );
    });
});

// backend/tests/properties/orders.pbt.test.js -- property-based tests for customer order
// reservation: a reservation exactly covers its order in ascending batch order, concurrent
// reservations can never oversell, and the reservation algorithm is deterministic and
// consistent regardless of submission order (design.md Properties 12-14, Req 7.1, 7.3, 7.5,
// 7.6, 7.7, 7.8, 15.3, 15.6).
//
// Conventions follow tests/properties/workOrders.pbt.test.js and
// tests/properties/transfers.pbt.test.js: one top-level `describe` per numbered property, a
// `// Feature: ...` tag comment naming it, a `// Validates: ...` comment matching design.md's
// wording, and a fresh Item per iteration (`createFreshItem`) so dbSetup.js's
// once-per-`test()` reset never has to be relied on between fast-check runs.
//
// ISOLATION: a fresh Item per iteration is enough on its own (the same reasoning
// workOrders.pbt.test.js and transfers.pbt.test.js use), so every property in this file
// reuses the fixture's `secondary` Location instead of also creating a fresh Location per
// iteration -- reserveAcrossBatches only scans records for one Item and one Location, and
// the fresh Item already guarantees no collision with the fixture's own records or another
// iteration's.

const crypto = require('crypto');
const { Item, InventoryRecord, InventoryTransaction, CustomerOrder } = require('../setup/tables');
const fc = require('fast-check');

const { agent } = require('../setup/agent');
const { FIXTURE_LOCATIONS, FIXTURE_CATEGORIES, tokenFor } = require('../setup/seedFixture');
const { genConcurrentQuantities } = require('../setup/generators');

// One HTTP POST plus a handful of direct DB reads per iteration, a similar cost shape to
// workOrders.pbt.test.js's Property 8. Uses exactly the numRuns: 25 floor of Req 12.7 for
// speed.
const RUNS_PROPERTY_12 = { numRuns: 25 };

// Property 13 dispatches 2-5 concurrent HTTP requests per iteration through
// Promise.allSettled, the same shape as tests/concurrency.test.js's mandatory concurrency
// test. Kept at exactly the numRuns: 25 floor of Req 12.7 for suite speed.
const RUNS_PROPERTY_13 = { numRuns: 25 };

// Property 14 runs two full sequential replays per iteration (2-4 requests each, so up to 8
// HTTP round-trips total), the most expensive property in this file. It stays at exactly
// the numRuns: 25 floor of Req 12.7 rather than above it.
const RUNS_PROPERTY_14 = { numRuns: 25 };

const LOCATION_ID = FIXTURE_LOCATIONS.secondary.id;

/**
 * A brand-new Item, so one property-test iteration's InventoryRecords and CustomerOrders
 * can never be confused with the fixture's or with another iteration's. Same rationale and
 * shape as workOrders.pbt.test.js's and transfers.pbt.test.js's `createFreshItem`.
 *
 * @returns {Promise<string>} the new Item's id
 */
async function createFreshItem() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const item = await Item.create({
        code: `PBT-ORD-${suffix}`,
        name: `Order property test item ${suffix}`,
        category: FIXTURE_CATEGORIES.rawMaterial.id,
    });
    return String(item._id);
}

// --- genOrderScenario -------------------------------------------------------------------
// 2..5 batches for one item/location, each with a Physical_Quantity/Reserved_Quantity pair
// with `reservedQuantity <= physicalQuantity - 1` (so every batch's Available_Quantity is
// always >= 1), plus an order Quantity strictly greater than the FIRST batch's own
// Available_Quantity and no greater than the total Available_Quantity across every batch --
// so a valid quantity always exists (the first batch alone can never satisfy it) and the
// property genuinely exercises multi-batch allocation rather than degenerating to a single
// batch every run.
//
// Batch labels are zero-padded index-based strings ("B00".."B04") generated in the same
// order the array itself is built, so the `ORDER BY batch` that reserveAcrossBatches issues
// reproduces exactly the array order below -- the test can then walk `batches` by index
// instead of re-deriving the sort order from label content. The zero padding is what makes
// that safe: these are strings, so "B10" would sort before "B2" without it.
const genBatchAvailability = fc.integer({ min: 1, max: 1000 }).chain((physicalQuantity) =>
    fc.integer({ min: 0, max: physicalQuantity - 1 }).map((reservedQuantity) => ({
        physicalQuantity,
        reservedQuantity,
    }))
);

const genOrderScenario = fc
    .array(genBatchAvailability, { minLength: 2, maxLength: 5 })
    .chain((layout) => {
        const batches = layout.map((entry, index) => ({
            ...entry,
            batch: `B${String(index).padStart(2, '0')}`,
            availableQuantity: entry.physicalQuantity - entry.reservedQuantity,
        }));
        const total = batches.reduce((sum, b) => sum + b.availableQuantity, 0);
        const firstAvailable = batches[0].availableQuantity;

        // `firstAvailable + 1 <= total` always holds: total is at least firstAvailable plus
        // one further batch's Available_Quantity (>= 1), since `layout` holds at least 2
        // entries and every entry's Available_Quantity is >= 1.
        return fc.integer({ min: firstAvailable + 1, max: total }).map((quantity) => ({
            batches,
            quantity,
        }));
    });

// Feature: mini-operations-erp, Property 12: A reservation exactly covers its order, in ascending batch order
describe('Property 12: A reservation exactly covers its order, in ascending batch order', () => {
    test('reservation entries sum to the order quantity, appear in ascending batch order with every batch but the last fully consumed, and each touched record gains exactly one ledger row and its entry quantity of reservedQuantity', async () => {
        const salesToken = await tokenFor('SalesUser');

        await fc.assert(
            fc.asyncProperty(genOrderScenario, async ({ batches, quantity }) => {
                const item = await createFreshItem();

                const createdRecords = await InventoryRecord.create(
                    batches.map(({ batch, physicalQuantity, reservedQuantity }) => ({
                        item,
                        location: LOCATION_ID,
                        batch,
                        physicalQuantity,
                        reservedQuantity,
                    }))
                );
                const recordIdByBatch = new Map(
                    createdRecords.map((record) => [record.batch, String(record._id)])
                );

                const response = await agent()
                    .post('/api/orders')
                    .set('Authorization', `Bearer ${salesToken}`)
                    .send({
                        customerName: 'Property 12 Customer',
                        item,
                        location: LOCATION_ID,
                        quantity,
                    });
                expect(response.status).toBe(201);

                const { reservations } = response.body;

                // Between 1 and 20 entries, every quantity greater than 0 (Req 15.3, 15.6).
                expect(reservations.length).toBeGreaterThanOrEqual(1);
                expect(reservations.length).toBeLessThanOrEqual(20);
                for (const entry of reservations) {
                    expect(entry.quantity).toBeGreaterThan(0);
                }

                // Entry quantities sum exactly to the order quantity (Req 15.3, 15.6).
                const sumOfEntries = reservations.reduce((sum, entry) => sum + entry.quantity, 0);
                expect(sumOfEntries).toBe(quantity);

                // Ascending batch order: since batch labels are index-based and zero-padded,
                // the batches touched must be a PREFIX of `batches` in the same order (Req
                // 7.1).
                expect(reservations.length).toBeLessThanOrEqual(batches.length);
                for (let i = 0; i < reservations.length; i += 1) {
                    expect(reservations[i].batch).toBe(batches[i].batch);
                }

                // Every batch before the last reservation entry is fully consumed: its
                // entry quantity equals that batch's own Available_Quantity at the time it
                // was reserved (Req 7.1).
                for (let i = 0; i < reservations.length - 1; i += 1) {
                    expect(reservations[i].quantity).toBe(batches[i].availableQuantity);
                }
                // The last entry consumes AT MOST its batch's Available_Quantity (it may
                // consume all of it too, when the order quantity lands exactly on a batch
                // boundary).
                const lastIndex = reservations.length - 1;
                expect(reservations[lastIndex].quantity).toBeLessThanOrEqual(
                    batches[lastIndex].availableQuantity
                );

                // Since the order Quantity is always strictly greater than the first
                // batch's own Available_Quantity, more than one batch is always touched --
                // this is the genuinely interesting multi-batch case, not a degenerate
                // single-batch allocation.
                expect(reservations.length).toBeGreaterThanOrEqual(2);

                const touchedBatchLabels = new Set(reservations.map((entry) => entry.batch));

                for (const batchInfo of batches) {
                    const recordId = recordIdByBatch.get(batchInfo.batch);
                    const ledgerRows = await InventoryTransaction.find({
                        inventoryRecord: recordId,
                    }).lean();
                    const record = await InventoryRecord.findById(recordId).lean();

                    if (touchedBatchLabels.has(batchInfo.batch)) {
                        // One ledger row per changed record, beyond that record's opening
                        // row -- these test records are created directly with no opening
                        // row, so the reservation's row is the only one (Req 7.1, 8.1).
                        expect(ledgerRows).toHaveLength(1);

                        const entry = reservations.find((r) => r.batch === batchInfo.batch);
                        expect(record.reservedQuantity).toBe(
                            batchInfo.reservedQuantity + entry.quantity
                        );
                    } else {
                        // An untouched batch (only possible when the order quantity landed
                        // before the end of `batches`): no ledger row, no reservedQuantity
                        // change.
                        expect(ledgerRows).toHaveLength(0);
                        expect(record.reservedQuantity).toBe(batchInfo.reservedQuantity);
                    }
                }
            }),
            RUNS_PROPERTY_12
        );
    });
});

// --- Property 13 ---------------------------------------------------------------------
// Concurrent reservations can never oversell (design.md Property 13, Req 7.5, 7.6, 7.7).
//
// Same "genuinely concurrent" technique as tests/concurrency.test.js's mandatory test: every
// request is built as a supertest `Test` object first, and only then is the whole array
// handed to `Promise.allSettled` together, so no one request is awaited on its own before
// the others are constructed. `genConcurrentQuantities` (tests/setup/generators.js) is
// reused as-is: it already generates an availability and 2..5 quantities whose sum is
// guaranteed to exceed it, which is exactly this property's scenario.
//
// A single-batch InventoryRecord is enough here. Property 12 already covers ascending
// multi-batch allocation; this property is about the race on ONE contested pool of
// availability, which a single record represents most directly.
//
// A losing request's rejection code: with 3 or more requests contending for the same
// InventoryRecord, `withTransaction`'s retry budget (Req 8.5, at most 3 retries) can be
// exhausted before a losing transaction ever gets a clean read of the state the winner (or
// winners) left behind -- every one of its attempts collides with a still-in-flight sibling
// transaction rather than observing a settled state. That losing request then surfaces 409
// `CONCURRENT_MODIFICATION` rather than 409 `INSUFFICIENT_AVAILABLE_QUANTITY`. Both are
// correct 409 rejections that create no Customer_Order and touch no Inventory_Record: the
// safety guarantee this property actually asserts -- the committed sum never exceeds the
// starting availability -- holds either way, and Req 8.5 documents `CONCURRENT_MODIFICATION`
// as the correct outcome of retry exhaustion. This is why every non-committed response below
// is accepted as either code rather than only `INSUFFICIENT_AVAILABLE_QUANTITY`.

// Feature: mini-operations-erp, Property 13: Concurrent reservations can never oversell
describe('Property 13: Concurrent reservations can never oversell', () => {
    test('the sum of committed quantities never exceeds the pre-request availability, every other request is rejected and creates no order, and reservedQuantity stays <= physicalQuantity afterward', async () => {
        const salesToken = await tokenFor('SalesUser');

        await fc.assert(
            fc.asyncProperty(genConcurrentQuantities, async ({ availability, quantities }) => {
                const item = await createFreshItem();

                await InventoryRecord.create({
                    item,
                    location: LOCATION_ID,
                    batch: 'ONLY',
                    physicalQuantity: availability,
                    reservedQuantity: 0,
                });

                // Every request is BUILT here, before any of them is awaited.
                const requests = quantities.map((quantity) =>
                    agent()
                        .post('/api/orders')
                        .set('Authorization', `Bearer ${salesToken}`)
                        .send({
                            customerName: 'Property 13 Customer',
                            item,
                            location: LOCATION_ID,
                            quantity,
                        })
                );

                // `Promise.allSettled` dispatches every underlying HTTP request as it
                // iterates, before any one response has arrived (same reasoning as
                // tests/concurrency.test.js).
                const settled = await Promise.allSettled(requests);
                const responses = settled.map((outcome) => {
                    if (outcome.status !== 'fulfilled') throw outcome.reason;
                    return outcome.value;
                });

                let committedSum = 0;
                for (let i = 0; i < responses.length; i += 1) {
                    const response = responses[i];
                    if (response.status === 201) {
                        committedSum += quantities[i];
                    } else {
                        // Every other request is rejected 409: INSUFFICIENT_AVAILABLE_QUANTITY
                        // when its conditional update or the location-total check fails
                        // (Req 7.5, 7.6), or CONCURRENT_MODIFICATION when three-or-more-way
                        // contention on this one record exhausts its retry budget before it
                        // ever observes a settled state (Req 8.5) -- see the file-level
                        // comment above for why both are correct outcomes here.
                        expect(response.status).toBe(409);
                        expect(['INSUFFICIENT_AVAILABLE_QUANTITY', 'CONCURRENT_MODIFICATION']).toContain(
                            response.body.code
                        );
                    }
                }

                // The sum of the quantities of the orders that receive 201 is <= the
                // availability measured before the set was submitted (Req 7.7).
                expect(committedSum).toBeLessThanOrEqual(availability);

                const orders = await CustomerOrder.find({ item, location: LOCATION_ID }).lean();
                const committedCount = responses.filter((r) => r.status === 201).length;

                // Every other request creates no order: exactly one Customer_Order per
                // committed request, none for a rejected one (Req 7.5, 7.6).
                expect(orders).toHaveLength(committedCount);

                const record = await InventoryRecord.findOne({
                    item,
                    location: LOCATION_ID,
                }).lean();

                // reservedQuantity <= physicalQuantity holds for the affected record
                // afterward (Req 7.7), and since the record started at reservedQuantity 0
                // with no other writer, the increase equals exactly the committed sum --
                // no oversell, no lost update.
                expect(record.reservedQuantity).toBeLessThanOrEqual(record.physicalQuantity);
                expect(record.reservedQuantity).toBe(committedSum);
            }),
            RUNS_PROPERTY_13
        );
    });
});

// --- Property 14 ---------------------------------------------------------------------
// Reservation outcome is order-independent (design.md Property 14, Req 7.8).
//
// This is a property about SUBMISSION ORDER, not concurrency: every request in a trial is
// awaited before the next one is sent, so there is no race here at all -- only the
// sequential order in which otherwise-independent requests are submitted varies between the
// two trials.
//
// design.md's prose ("whenever the same subset of requests commits, the final total
// reserved quantity ... is the same") is not a claim that the SAME subset always commits
// regardless of order -- sequential first-fit allocation can and does let submission order
// change which individual requests fit. What actually has to hold, and what the reservation
// algorithm is required to be, is DETERMINISTIC and CONSISTENT bookkeeping: whichever subset
// of requests a given ordering happens to commit, the resulting reservedQuantity total for
// that ordering is exactly the sum of that subset's quantities (no partial reservation, no
// double counting), it never exceeds the availability the pool started with, and -- the
// genuinely order-INDEPENDENT part -- if two different orderings happen to commit the same
// subset (by original request identity, not merely by value), their resulting totals agree,
// because that total is nothing more than the sum of the same set of quantities either way.
//
// Each of the two trials below starts from a freshly created Item and a freshly created
// InventoryRecord with the SAME availability, so "identical starting inventory" (design.md)
// holds without the two trials ever touching the same document.

/**
 * Generates one scenario: an availability, and 2..4 quantities each individually within that
 * availability (so no single request is disqualified before the race over ordering can even
 * begin), plus two independently generated permutations of the request indices to submit
 * them in.
 */
const genOrderingScenario = fc
    .integer({ min: 5, max: 200 })
    .chain((availability) =>
        fc
            .array(fc.integer({ min: 1, max: availability }), { minLength: 2, maxLength: 4 })
            .chain((quantities) => {
                const indices = quantities.map((_, index) => index);
                return fc
                    .tuple(
                        fc.shuffledSubarray(indices, {
                            minLength: indices.length,
                            maxLength: indices.length,
                        }),
                        fc.shuffledSubarray(indices, {
                            minLength: indices.length,
                            maxLength: indices.length,
                        })
                    )
                    .map(([orderA, orderB]) => ({ availability, quantities, orderA, orderB }));
            })
    );

/**
 * Runs one sequential submission trial: a fresh Item and InventoryRecord (Physical_Quantity
 * = `availability`, Reserved_Quantity 0), then one awaited `POST /api/orders` per index in
 * `order`, in that order.
 *
 * @param {number} availability
 * @param {number[]} quantities the full quantity list, indexed by original request identity
 * @param {number[]} order a permutation of `quantities`' indices, the submission order
 * @param {string} salesToken
 * @returns {Promise<{ committedIndices: Set<number>, reservedQuantity: number }>}
 */
async function runSequentialTrial(availability, quantities, order, salesToken) {
    const item = await createFreshItem();
    await InventoryRecord.create({
        item,
        location: LOCATION_ID,
        batch: 'ONLY',
        physicalQuantity: availability,
        reservedQuantity: 0,
    });

    const committedIndices = new Set();
    let committedSum = 0;

    for (const index of order) {
        // Awaited one at a time: this is deliberately sequential, not concurrent.
        const response = await agent()
            .post('/api/orders')
            .set('Authorization', `Bearer ${salesToken}`)
            .send({
                customerName: 'Property 14 Customer',
                item,
                location: LOCATION_ID,
                quantity: quantities[index],
            });

        if (response.status === 201) {
            committedIndices.add(index);
            committedSum += quantities[index];
        } else {
            expect(response.status).toBe(409);
            expect(response.body.code).toBe('INSUFFICIENT_AVAILABLE_QUANTITY');
        }
    }

    const record = await InventoryRecord.findOne({ item, location: LOCATION_ID }).lean();

    // Deterministic, consistent bookkeeping for THIS ordering: the final reservedQuantity is
    // exactly the sum of the subset that committed (Req 7.8), and it never exceeds the
    // availability the pool started with (no oversell under sequential submission either).
    expect(record.reservedQuantity).toBe(committedSum);
    expect(record.reservedQuantity).toBeLessThanOrEqual(availability);

    return { committedIndices, reservedQuantity: record.reservedQuantity };
}

// Feature: mini-operations-erp, Property 14: Reservation outcome is order-independent
describe('Property 14: Reservation outcome is order-independent', () => {
    test('each submission ordering reserves exactly the sum of the subset it commits, and two orderings that happen to commit the same subset agree on the resulting total', async () => {
        const salesToken = await tokenFor('SalesUser');

        await fc.assert(
            fc.asyncProperty(
                genOrderingScenario,
                async ({ availability, quantities, orderA, orderB }) => {
                    const trialA = await runSequentialTrial(
                        availability,
                        quantities,
                        orderA,
                        salesToken
                    );
                    const trialB = await runSequentialTrial(
                        availability,
                        quantities,
                        orderB,
                        salesToken
                    );

                    // The order-INDEPENDENT part: when the two orderings happen to commit
                    // the same subset of requests (by original request identity), the
                    // resulting reservedQuantity totals agree (Req 7.8). Submission order is
                    // otherwise free to change WHICH subset commits -- that is not what this
                    // property claims.
                    const sameSubsetCommitted =
                        trialA.committedIndices.size === trialB.committedIndices.size &&
                        [...trialA.committedIndices].every((index) =>
                            trialB.committedIndices.has(index)
                        );

                    if (sameSubsetCommitted) {
                        expect(trialA.reservedQuantity).toBe(trialB.reservedQuantity);
                    }
                }
            ),
            RUNS_PROPERTY_14
        );
    });
});

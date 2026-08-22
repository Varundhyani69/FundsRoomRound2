// backend/tests/properties/orders.pbt.test.js -- property-based test for customer order
// reservation: a reservation exactly covers its order, in ascending batch order
// (design.md Property 12, Req 7.1, 7.3, 15.3, 15.6).
//
// Conventions follow tests/properties/workOrders.pbt.test.js and
// tests/properties/transfers.pbt.test.js: one top-level `describe` per numbered property, a
// `// Feature: ...` tag comment naming it, a `// Validates: ...` comment matching design.md's
// wording, and a fresh Item per iteration (`createFreshItem`) so dbSetup.js's
// once-per-`test()` reset never has to be relied on between fast-check runs.
//
// ISOLATION: a fresh Item per iteration is enough on its own (the same reasoning
// workOrders.pbt.test.js and transfers.pbt.test.js use), so this property reuses the
// fixture's `secondary` Location instead of also creating a fresh Location per iteration --
// reserveAcrossBatches only scans records for one Item and one Location, and the fresh Item
// already guarantees no collision with the fixture's own records or another iteration's.

const crypto = require('crypto');
const fc = require('fast-check');

const Item = require('../../src/models/Item');
const InventoryRecord = require('../../src/models/InventoryRecord');
const InventoryTransaction = require('../../src/models/InventoryTransaction');
const { agent } = require('../setup/agent');
const { FIXTURE_LOCATIONS, FIXTURE_CATEGORIES, tokenFor } = require('../setup/seedFixture');

// One HTTP POST plus a handful of direct DB reads per iteration, a similar cost shape to
// workOrders.pbt.test.js's Property 8. 30 runs clears the numRuns: 25 floor of Req 12.7
// while keeping this file's run time reasonable.
const RUNS_PROPERTY_12 = { numRuns: 30 };

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
// order the array itself is built, so MongoDB's ascending string sort on `batch` reproduces
// exactly the array order below -- the test can then walk `batches` by index instead of
// re-deriving the sort order from label content.
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

// backend/tests/properties/transfers.pbt.test.js -- property-based tests for the internal
// transfer lifecycle: quantity conservation with stock hidden in transit, and receipt
// idempotence (design.md Properties 10-11, Req 6).
//
// Conventions follow tests/properties/inventory.pbt.test.js and
// tests/properties/workOrders.pbt.test.js: one top-level `describe` per numbered property, a
// `// Feature: ...` tag comment naming it, a `// Validates: ...` comment matching design.md's
// wording, and a fresh Item per iteration (`createFreshItem`) so dbSetup.js's
// once-per-`test()` reset never has to be relied on between fast-check runs.
//
// Both properties drive the real routes over HTTP through the exported app -- the same
// reason Properties 2-9 do: everything here involves the validation layer, the transaction
// wrapper, or the guards actually living in transfer.service.js (`assertTransferTransition`,
// the availability check in `dispatchTransfer`, the duplicate-receipt remapping in
// `receiveTransfer`).
//
// ISOLATION: a fresh Item per iteration is enough on its own (the same reasoning
// inventory.pbt.test.js and workOrders.pbt.test.js use), so both properties below reuse the
// fixture's two Locations (`main` as source, `secondary` as destination) instead of also
// creating fresh Locations per iteration -- a transfer's natural key only needs Item,
// Location, and Batch to be unique together, and the fresh Item already guarantees that.

const crypto = require('crypto');
const { Item, InventoryRecord, InventoryTransaction, InternalTransfer } = require('../setup/tables');
const fc = require('fast-check');

const { transferMovementReference } = require('../../src/services/movementReference');
const { agent } = require('../setup/agent');
const { FIXTURE_LOCATIONS, FIXTURE_CATEGORIES, tokenFor } = require('../setup/seedFixture');

// Both properties issue a handful of real HTTP requests per iteration (create, dispatch,
// and one or more receive attempts) plus several direct DB reads, a similar cost shape to
// inventory.pbt.test.js's Properties 3, 5, and 6. Both use exactly the numRuns: 25 floor of
// Req 12.7 for speed.
const RUNS_PROPERTY_10 = { numRuns: 25 };
const RUNS_PROPERTY_11 = { numRuns: 25 }; // up to 5 sequential receive requests per run

const SOURCE_LOCATION_ID = FIXTURE_LOCATIONS.main.id;
const DESTINATION_LOCATION_ID = FIXTURE_LOCATIONS.secondary.id;
const TRANSFER_BATCH = 'PROP-TRANSFER';

/**
 * A brand-new Item, so one property-test iteration's InventoryRecords and
 * InternalTransfers can never be confused with the fixture's or with another iteration's.
 * Same rationale and shape as inventory.pbt.test.js's and workOrders.pbt.test.js's
 * `createFreshItem`.
 *
 * @returns {Promise<string>} the new Item's id
 */
async function createFreshItem() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const item = await Item.create({
        code: `PBT-TR-${suffix}`,
        name: `Transfer property test item ${suffix}`,
        category: FIXTURE_CATEGORIES.rawMaterial.id,
    });
    return String(item._id);
}

/** Reads back one Inventory_Record by its natural key, or null when none exists. */
const findRecord = (item, location, batch = TRANSFER_BATCH) =>
    InventoryRecord.findOne({ item, location, batch }).lean();

// --- genSourceAndQuantity ------------------------------------------------------------
// A source Physical_Quantity/Reserved_Quantity pair with `reservedQuantity <= physicalQuantity
// - 1` (so Available_Quantity is always >= 1, the room needed for the generated transfer
// quantity to exist), and a transfer quantity within that resulting Available_Quantity
// (Req 6.4, 6.1). Bounded well below the 1,000,000 Valid_Quantity ceiling -- the same choice
// inventory.pbt.test.js's Property 6 makes -- since this property is about the conservation
// arithmetic, not about exercising the outer edges of the quantity range (that is Property 7).
const genSourceAndQuantity = fc.integer({ min: 1, max: 1000 }).chain((physicalQuantity) =>
    fc.integer({ min: 0, max: physicalQuantity - 1 }).chain((reservedQuantity) => {
        const available = physicalQuantity - reservedQuantity;
        return fc.integer({ min: 1, max: available }).map((quantity) => ({
            physicalQuantity,
            reservedQuantity,
            quantity,
        }));
    })
);

// --- genTransferScenario --------------------------------------------------------------
// Property 10's full input: a source layout and quantity from `genSourceAndQuantity`, plus
// whether the destination Inventory_Record pre-exists and, if so, the baseline
// Physical_Quantity it starts with. The baseline is generated even when the destination does
// not pre-exist because that branch simply never uses it.
const genTransferScenario = fc.tuple(genSourceAndQuantity, fc.boolean(), fc.integer({ min: 0, max: 500 })).map(
    ([source, destinationPreExists, destinationBaselinePhysical]) => ({
        ...source,
        destinationPreExists,
        destinationBaselinePhysical,
    })
);

// Feature: mini-operations-erp, Property 10: Transfers conserve quantity and hide stock in transit
describe('Property 10: Transfers conserve quantity and hide stock in transit', () => {
    test('destination is unchanged until receipt, total quantity is conserved, and a missing destination record is created with reservedQuantity 0', async () => {
        const opsToken = await tokenFor('OperationsUser');
        let counter = 0;

        await fc.assert(
            fc.asyncProperty(genTransferScenario, async (scenario) => {
                const {
                    physicalQuantity,
                    reservedQuantity,
                    quantity,
                    destinationPreExists,
                    destinationBaselinePhysical,
                } = scenario;

                const item = await createFreshItem();
                counter += 1;

                await InventoryRecord.create({
                    item,
                    location: SOURCE_LOCATION_ID,
                    batch: TRANSFER_BATCH,
                    physicalQuantity,
                    reservedQuantity,
                });

                if (destinationPreExists) {
                    await InventoryRecord.create({
                        item,
                        location: DESTINATION_LOCATION_ID,
                        batch: TRANSFER_BATCH,
                        physicalQuantity: destinationBaselinePhysical,
                        reservedQuantity: 0,
                    });
                }

                const totalBefore =
                    physicalQuantity + (destinationPreExists ? destinationBaselinePhysical : 0);

                const created = await agent()
                    .post('/api/transfers')
                    .set('Authorization', `Bearer ${opsToken}`)
                    .send({
                        item,
                        batch: TRANSFER_BATCH,
                        sourceLocation: SOURCE_LOCATION_ID,
                        destinationLocation: DESTINATION_LOCATION_ID,
                        quantity,
                    });
                expect(created.status).toBe(201);
                expect(created.body.status).toBe('Requested');
                const transferId = created.body.id;

                // While Requested: no Inventory_Record change on either side, and no ledger
                // row referencing this transfer yet (Req 6.3).
                const sourceWhileRequested = await findRecord(item, SOURCE_LOCATION_ID);
                expect(sourceWhileRequested.physicalQuantity).toBe(physicalQuantity);
                expect(sourceWhileRequested.reservedQuantity).toBe(reservedQuantity);

                const destinationWhileRequested = await findRecord(item, DESTINATION_LOCATION_ID);
                if (destinationPreExists) {
                    expect(destinationWhileRequested.physicalQuantity).toBe(destinationBaselinePhysical);
                } else {
                    expect(destinationWhileRequested).toBeNull();
                }

                const ledgerWhileRequested = await InventoryTransaction.find({
                    movementReference: {
                        $in: [
                            transferMovementReference(transferId, 'DISPATCH'),
                            transferMovementReference(transferId, 'RECEIPT'),
                        ],
                    },
                }).lean();
                expect(ledgerWhileRequested).toHaveLength(0);

                // First reading of the destination, taken before dispatch.
                const destinationBeforeDispatch = destinationPreExists
                    ? destinationBaselinePhysical
                    : 0;

                const dispatch = await agent()
                    .post(`/api/transfers/${transferId}/dispatch`)
                    .set('Authorization', `Bearer ${opsToken}`)
                    .send({});
                expect(dispatch.status).toBe(200);
                expect(dispatch.body.status).toBe('Dispatched');

                // Second reading, while Dispatched: must equal the first -- no early
                // increase at the destination (Req 6.6).
                const destinationWhileDispatched = await findRecord(item, DESTINATION_LOCATION_ID);
                const destinationWhileDispatchedPhysical = destinationWhileDispatched
                    ? destinationWhileDispatched.physicalQuantity
                    : 0;
                expect(destinationWhileDispatchedPhysical).toBe(destinationBeforeDispatch);

                const receive = await agent()
                    .post(`/api/transfers/${transferId}/receive`)
                    .set('Authorization', `Bearer ${opsToken}`)
                    .send({});
                expect(receive.status).toBe(200);
                expect(receive.body.status).toBe('Received');
                expect(receive.body.receivedQuantity).toBe(quantity);

                // Third reading, after Received.
                const destinationAfterReceived = await findRecord(item, DESTINATION_LOCATION_ID);
                expect(destinationAfterReceived).not.toBeNull();
                expect(destinationAfterReceived.physicalQuantity).toBe(
                    destinationBeforeDispatch + quantity
                );
                if (!destinationPreExists) {
                    // Req 6.8: a receipt against a missing destination record creates it
                    // with reservedQuantity 0.
                    expect(destinationAfterReceived.reservedQuantity).toBe(0);
                }

                const sourceAfterReceived = await findRecord(item, SOURCE_LOCATION_ID);
                expect(sourceAfterReceived.physicalQuantity).toBe(physicalQuantity - quantity);

                // Conservation: total physical quantity for this item across both
                // locations after receipt equals the total before dispatch (Req 6.11).
                const totalAfter =
                    sourceAfterReceived.physicalQuantity + destinationAfterReceived.physicalQuantity;
                expect(totalAfter).toBe(totalBefore);
            }),
            RUNS_PROPERTY_10
        );
    });
});

// --- genReceiptScenario -----------------------------------------------------------------
// A repeat count of 2..5 (the same shape inventory.pbt.test.js's Property 5 uses for its
// repeated-submission loop) and a source layout with strictly more Physical_Quantity than the
// transfer quantity, so dispatch always succeeds with room to spare.
const genReceiptScenario = fc.integer({ min: 2, max: 5 }).chain((repeatCount) =>
    fc.integer({ min: 1, max: 1000 }).chain((quantity) =>
        fc.integer({ min: 0, max: 500 }).map((extraPhysical) => ({
            repeatCount,
            quantity,
            physicalQuantity: quantity + extraPhysical,
        }))
    )
);

// Feature: mini-operations-erp, Property 11: Receipt is idempotent and received quantity stays bounded
describe('Property 11: Receipt is idempotent and received quantity stays bounded', () => {
    test('exactly one of k sequential receipt requests is applied, one ledger row is written, and receivedQuantity never exceeds the transfer quantity', async () => {
        const opsToken = await tokenFor('OperationsUser');

        await fc.assert(
            fc.asyncProperty(genReceiptScenario, async ({ repeatCount, quantity, physicalQuantity }) => {
                const item = await createFreshItem();

                await InventoryRecord.create({
                    item,
                    location: SOURCE_LOCATION_ID,
                    batch: TRANSFER_BATCH,
                    physicalQuantity,
                    reservedQuantity: 0,
                });

                const created = await agent()
                    .post('/api/transfers')
                    .set('Authorization', `Bearer ${opsToken}`)
                    .send({
                        item,
                        batch: TRANSFER_BATCH,
                        sourceLocation: SOURCE_LOCATION_ID,
                        destinationLocation: DESTINATION_LOCATION_ID,
                        quantity,
                    });
                expect(created.status).toBe(201);
                const transferId = created.body.id;

                const dispatch = await agent()
                    .post(`/api/transfers/${transferId}/dispatch`)
                    .set('Authorization', `Bearer ${opsToken}`)
                    .send({});
                expect(dispatch.status).toBe(200);

                // receivedQuantity is 0 before any receipt is applied (Req 15.2).
                const beforeReceipt = await InternalTransfer.findById(transferId).lean();
                expect(beforeReceipt.receivedQuantity).toBe(0);

                // k sequential (not concurrent) receipt requests against the SAME transfer,
                // one after another -- the same reasoning inventory.pbt.test.js's Property 5
                // gives for testing idempotency rather than concurrency (that is Req 6.16,
                // covered by the mandatory HTTP tests, not this property).
                const responses = [];
                for (let i = 0; i < repeatCount; i += 1) {
                    responses.push(
                        // eslint-disable-next-line no-await-in-loop -- k repeats of the SAME
                        // receipt must be submitted one after another to test idempotency.
                        await agent()
                            .post(`/api/transfers/${transferId}/receive`)
                            .set('Authorization', `Bearer ${opsToken}`)
                            .send({})
                    );
                }

                const accepted = responses.filter((response) => response.status === 200);
                const rejected = responses.filter((response) => response.status === 409);
                expect(accepted).toHaveLength(1);
                expect(rejected).toHaveLength(repeatCount - 1);
                for (const response of rejected) {
                    expect(response.body.code).toBe('TRANSFER_ALREADY_RECEIVED');
                }

                // At most (here, exactly) one ledger row carries this transfer's receipt
                // reference (Req 6.12).
                const receiptLedgerRows = await InventoryTransaction.find({
                    movementReference: transferMovementReference(transferId, 'RECEIPT'),
                }).lean();
                expect(receiptLedgerRows).toHaveLength(1);

                // receivedQuantity equals the transfer quantity after receipt, and never
                // exceeds it (Req 15.2's schema-level bound backs this, but the read here
                // confirms the service never sets it any other way).
                const afterReceipt = await InternalTransfer.findById(transferId).lean();
                expect(afterReceipt.status).toBe('Received');
                expect(afterReceipt.receivedQuantity).toBe(quantity);
                expect(afterReceipt.receivedQuantity).toBeLessThanOrEqual(quantity);

                // The resulting Inventory_Record state equals the state after a single
                // accepted receipt: exactly `quantity` physical at the destination, reserved
                // still 0.
                const destinationRecord = await findRecord(item, DESTINATION_LOCATION_ID);
                expect(destinationRecord.physicalQuantity).toBe(quantity);
                expect(destinationRecord.reservedQuantity).toBe(0);
            }),
            RUNS_PROPERTY_11
        );
    });
});

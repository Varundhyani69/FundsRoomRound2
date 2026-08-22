// backend/tests/inventory.test.js -- inventory creation, adjustment, and reads
// (Req 3.4, 3.7, 3.11, 3.12, 4.2, 4.3, 4.9).
//
// Every assertion is made over real HTTP against the exported app, so `validate`,
// `authorize`, the controller and `inventory.service.js` all run inside each
// assertion (Req 12.13). The full role x route matrix for every write route lives in
// authorization.test.js and src/permissions.js; the one check at the bottom of this
// file only confirms POST /api/inventory is actually wired into that map.

const InventoryRecord = require('../src/models/InventoryRecord');
const InventoryTransaction = require('../src/models/InventoryTransaction');
const { openingMovementReference } = require('../src/services/movementReference');
const { agent } = require('./setup/agent');
const {
    FIXTURE_ITEMS,
    FIXTURE_LOCATIONS,
    FIXTURE_INVENTORY_RECORDS,
    tokenFor,
} = require('./setup/seedFixture');

const CREATE = '/api/inventory';
const LIST = '/api/inventory';
const AVAILABILITY = '/api/inventory/availability';
const adjustRoute = (id) => `/api/inventory/${id}/adjust`;

// 24-character hex strings, but deliberately outside every id block seedFixture.js
// declares, so they name nothing in the seeded database.
const UNUSED_ITEM_ID = '00000000000000000000ff01';
const UNUSED_LOCATION_ID = '00000000000000000000ff02';
const UNKNOWN_RECORD_ID = '00000000000000000000ff03';
const MALFORMED_ID = 'not-a-valid-object-id';

const post = async (route, body, role = 'Admin') =>
    agent()
        .post(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`)
        .send(body);

const get = async (route, query, role = 'Admin') =>
    agent()
        .get(route)
        .query(query)
        .set('Authorization', `Bearer ${await tokenFor(role)}`);

/** Every InventoryRecord as stored, sorted so comparisons do not depend on insertion order. */
const snapshotRecords = () => InventoryRecord.find({}).sort({ _id: 1 }).lean();

describe('POST /api/inventory -- creation (Req 3.10, 3.11, 4.9)', () => {
    test('201s with the documented shape and writes the opening ledger row', async () => {
        const response = await post(CREATE, {
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.secondary.id,
            batch: 'NEWBATCH',
            physicalQuantity: 42,
            movementReference: 'creation-test-opening',
        });

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            id: expect.any(String),
            item: {
                id: FIXTURE_ITEMS.widget.id,
                code: 'WIDGET',
                name: FIXTURE_ITEMS.widget.name,
                category: { id: FIXTURE_ITEMS.widget.category, name: 'Raw Material' },
            },
            location: {
                id: FIXTURE_LOCATIONS.secondary.id,
                code: 'SEC',
                name: FIXTURE_LOCATIONS.secondary.name,
            },
            batch: 'NEWBATCH',
            physicalQuantity: 42,
            reservedQuantity: 0,
            availableQuantity: 42,
        });

        // The opening ledger row exists, and physicalQuantity reconstructs from it
        // (Req 4.9): summing every InventoryTransaction row for the new record must
        // equal the physicalQuantity the create response reported.
        const rows = await InventoryTransaction.find({ inventoryRecord: response.body.id });
        expect(rows).toHaveLength(1);
        expect(rows[0].movementReference).toBe(openingMovementReference(response.body.id));
        expect(rows[0].physicalDelta).toBe(42);
        expect(rows[0].reservedDelta).toBe(0);

        const reconstructedPhysical = rows.reduce((total, row) => total + row.physicalDelta, 0);
        expect(reconstructedPhysical).toBe(42);
    });

    test('a duplicate {item, location, batch} triple is rejected 409 DUPLICATE_INVENTORY_RECORD', async () => {
        const before = await snapshotRecords();
        const fixtureRecord = FIXTURE_INVENTORY_RECORDS.widgetMainBatchA;

        const response = await post(CREATE, {
            item: fixtureRecord.item,
            location: fixtureRecord.location,
            batch: fixtureRecord.batch,
            physicalQuantity: 5,
            movementReference: 'creation-test-duplicate',
        });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'DUPLICATE_INVENTORY_RECORD',
            message: expect.any(String),
        });
        // No new record created, and every existing record is unchanged.
        expect(await snapshotRecords()).toEqual(before);
    });

    test.each([
        ['an unknown item', { item: UNUSED_ITEM_ID, location: FIXTURE_LOCATIONS.main.id }],
        ['an unknown location', { item: FIXTURE_ITEMS.widget.id, location: UNUSED_LOCATION_ID }],
    ])('%s is rejected 400 INVALID_REFERENCE', async (_label, refs) => {
        const before = await snapshotRecords();

        const response = await post(CREATE, {
            ...refs,
            batch: 'REF-TEST',
            physicalQuantity: 5,
            movementReference: 'creation-test-invalid-reference',
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'INVALID_REFERENCE', message: expect.any(String) });
        expect(await snapshotRecords()).toEqual(before);
    });

    // Req 3.10's starting-balance range (0 to 999,999,999) is validated by its own schema
    // with no INVALID_QUANTITY marker, so an out-of-range starting quantity falls back to
    // the plain VALIDATION_ERROR a schema violation ordinarily produces (Req 9.4), not
    // INVALID_QUANTITY -- that code is reserved for a movement against an existing record.
    test.each([
        ['negative', -1],
        ['above the 999,999,999 ceiling', 1_000_000_000],
        ['not a whole number', 4.5],
    ])('a starting quantity that is %s is rejected 400 VALIDATION_ERROR', async (_label, physicalQuantity) => {
        const response = await post(CREATE, {
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.secondary.id,
            batch: 'QTY-TEST',
            physicalQuantity,
            movementReference: 'creation-test-invalid-quantity',
        });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
    });
});

describe('POST /api/inventory/:id/adjust (Req 4.2, 4.3, 4.6)', () => {
    test('IN increases physicalQuantity and writes one ledger row', async () => {
        const target = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB;

        const response = await post(adjustRoute(target.id), {
            direction: 'IN',
            quantity: 10,
            movementReference: 'adjust-test-in',
        });

        expect(response.status).toBe(200);
        expect(response.body.physicalQuantity).toBe(target.physicalQuantity + 10);
        expect(response.body.reservedQuantity).toBe(target.reservedQuantity);

        const rows = await InventoryTransaction.find({ inventoryRecord: target.id });
        // One opening row from the fixture plus this one adjustment.
        expect(rows).toHaveLength(2);
        const adjustmentRow = rows.find((row) => row.physicalDelta === 10);
        expect(adjustmentRow).toBeDefined();
        expect(adjustmentRow.reservedDelta).toBe(0);
    });

    test('OUT decreases physicalQuantity and writes one ledger row', async () => {
        const target = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB;

        const response = await post(adjustRoute(target.id), {
            direction: 'OUT',
            quantity: 10,
            movementReference: 'adjust-test-out',
        });

        expect(response.status).toBe(200);
        expect(response.body.physicalQuantity).toBe(target.physicalQuantity - 10);
        expect(response.body.reservedQuantity).toBe(target.reservedQuantity);

        const rows = await InventoryTransaction.find({ inventoryRecord: target.id });
        expect(rows).toHaveLength(2);
        const adjustmentRow = rows.find((row) => row.physicalDelta === -10);
        expect(adjustmentRow).toBeDefined();
        expect(adjustmentRow.reservedDelta).toBe(0);
    });

    test('OUT beyond the physical quantity is rejected 409 INSUFFICIENT_PHYSICAL_QUANTITY, quantities unchanged', async () => {
        const target = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB; // physical 50, reserved 0

        const response = await post(adjustRoute(target.id), {
            direction: 'OUT',
            quantity: target.physicalQuantity + 50,
            movementReference: 'adjust-test-insufficient',
        });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INSUFFICIENT_PHYSICAL_QUANTITY',
            message: expect.any(String),
        });

        const stored = await InventoryRecord.findById(target.id).lean();
        expect(stored.physicalQuantity).toBe(target.physicalQuantity);
        expect(stored.reservedQuantity).toBe(target.reservedQuantity);
    });

    test.each([
        ['zero', 0],
        ['negative', -5],
        ['above the 1,000,000 ceiling', 1_000_001],
    ])('a quantity that is %s is rejected 400 INVALID_QUANTITY', async (_label, quantity) => {
        const target = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB;

        const response = await post(adjustRoute(target.id), {
            direction: 'IN',
            quantity,
            movementReference: 'adjust-test-invalid-quantity',
        });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_QUANTITY');
    });

    test('a repeated movementReference on the same record is rejected 409 DUPLICATE_INVENTORY_TRANSACTION, quantities unchanged', async () => {
        const target = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB;
        const body = { direction: 'IN', quantity: 15, movementReference: 'adjust-test-dup-ref' };

        const first = await post(adjustRoute(target.id), body);
        expect(first.status).toBe(200);
        const afterFirst = await InventoryRecord.findById(target.id).lean();

        const second = await post(adjustRoute(target.id), body);

        expect(second.status).toBe(409);
        expect(second.body).toEqual({
            code: 'DUPLICATE_INVENTORY_TRANSACTION',
            message: expect.any(String),
        });

        // Neither reverted to before the first call nor double-applied: exactly
        // what the first, successful call left behind.
        const afterSecond = await InventoryRecord.findById(target.id).lean();
        expect(afterSecond.physicalQuantity).toBe(afterFirst.physicalQuantity);
        expect(afterSecond.reservedQuantity).toBe(afterFirst.reservedQuantity);
    });

    test('an unknown record id is rejected 404 NOT_FOUND', async () => {
        const response = await post(adjustRoute(UNKNOWN_RECORD_ID), {
            direction: 'IN',
            quantity: 5,
            movementReference: 'adjust-test-not-found',
        });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    });

    test('a malformed record id is rejected 400 INVALID_IDENTIFIER', async () => {
        const response = await post(adjustRoute(MALFORMED_ID), {
            direction: 'IN',
            quantity: 5,
            movementReference: 'adjust-test-malformed-id',
        });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_IDENTIFIER');
    });
});

describe('GET /api/inventory -- reads (Req 3.2)', () => {
    // Order is not part of the documented shape, so both sides are sorted by id
    // before comparing rather than relying on an implicit collection order.
    const byId = (records) => [...records].sort((a, b) => a.id.localeCompare(b.id));

    test('returns the fixture records in the documented shape', async () => {
        const response = await get(LIST, {});

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(3);

        const shapes = byId(response.body);
        const widgetA = shapes.find((record) => record.id === FIXTURE_INVENTORY_RECORDS.widgetMainBatchA.id);
        expect(widgetA).toEqual({
            id: FIXTURE_INVENTORY_RECORDS.widgetMainBatchA.id,
            item: {
                id: FIXTURE_ITEMS.widget.id,
                code: 'WIDGET',
                name: FIXTURE_ITEMS.widget.name,
                category: { id: FIXTURE_ITEMS.widget.category, name: 'Raw Material' },
            },
            location: {
                id: FIXTURE_LOCATIONS.main.id,
                code: 'MAIN',
                name: FIXTURE_LOCATIONS.main.name,
            },
            batch: 'A',
            physicalQuantity: 100,
            reservedQuantity: 30,
            availableQuantity: 70,
        });
    });

    test('an item filter narrows the list to that item', async () => {
        const response = await get(LIST, { item: FIXTURE_ITEMS.widget.id });

        expect(response.status).toBe(200);
        expect(byId(response.body).map((record) => record.id)).toEqual(
            byId([
                FIXTURE_INVENTORY_RECORDS.widgetMainBatchA,
                FIXTURE_INVENTORY_RECORDS.widgetMainBatchB,
            ]).map((record) => record.id)
        );
    });

    test('a location filter narrows the list to that location', async () => {
        const response = await get(LIST, { location: FIXTURE_LOCATIONS.secondary.id });

        expect(response.status).toBe(200);
        expect(response.body.map((record) => record.id)).toEqual([
            FIXTURE_INVENTORY_RECORDS.gadgetSecondaryLow.id,
        ]);
    });

    test('combined item and location filters narrow the list to their intersection', async () => {
        const response = await get(LIST, {
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.main.id,
        });

        expect(response.status).toBe(200);
        expect(byId(response.body).map((record) => record.id)).toEqual(
            byId([
                FIXTURE_INVENTORY_RECORDS.widgetMainBatchA,
                FIXTURE_INVENTORY_RECORDS.widgetMainBatchB,
            ]).map((record) => record.id)
        );
    });
});

describe('GET /api/inventory/availability (Req 3.5, 3.12)', () => {
    test('reports 0 for an item/location pair with no records', async () => {
        const response = await get(AVAILABILITY, {
            item: FIXTURE_ITEMS.gadget.id,
            location: FIXTURE_LOCATIONS.main.id,
        });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            item: FIXTURE_ITEMS.gadget.id,
            location: FIXTURE_LOCATIONS.main.id,
            locationAvailableQuantity: 0,
        });
    });

    test('sums Available_Quantity across every batch for the pair', async () => {
        // widgetMainBatchA: physical 100, reserved 30 -> available 70
        // widgetMainBatchB: physical 50, reserved 0 -> available 50
        // 70 + 50 = 120
        const response = await get(AVAILABILITY, {
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.main.id,
        });

        expect(response.status).toBe(200);
        expect(response.body.locationAvailableQuantity).toBe(120);
    });

    test('a missing query parameter is rejected 400', async () => {
        const response = await get(AVAILABILITY, { item: FIXTURE_ITEMS.widget.id });

        expect(response.status).toBe(400);
    });
});

describe('authorization wiring spot check (Req 2.5)', () => {
    // The full role x route matrix lives in authorization.test.js and
    // src/permissions.js; this only confirms POST /api/inventory is actually
    // reachable through that check rather than bypassing it.
    test('a SalesUser token is denied 403 FORBIDDEN on POST /api/inventory', async () => {
        const response = await post(
            CREATE,
            {
                item: FIXTURE_ITEMS.widget.id,
                location: FIXTURE_LOCATIONS.secondary.id,
                batch: 'AUTH-TEST',
                physicalQuantity: 5,
                movementReference: 'auth-spot-check',
            },
            'SalesUser'
        );

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ code: 'FORBIDDEN', message: expect.any(String) });
    });
});

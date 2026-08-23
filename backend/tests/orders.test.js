// backend/tests/orders.test.js -- customer order creation, ascending-batch stock
// reservation, and the mandatory over-availability test (Req 7.1, 7.2, 7.3, 7.9, 7.10,
// 7.11, 7.12, 12.1, 12.13).
//
// Every assertion is made over real HTTP against the exported app, so `validate`,
// `authorize`, the controller and `order.service.js` all run inside each assertion
// (Req 12.13). The full role x route matrix for every write route lives in
// authorization.test.js and src/permissions.js, so this file does not repeat it.

const { agent } = require('./setup/agent');
const { InventoryRecord, InventoryTransaction, CustomerOrder } = require('./setup/tables');
const {
    FIXTURE_ITEMS,
    FIXTURE_LOCATIONS,
    FIXTURE_INVENTORY_RECORDS,
    tokenFor,
} = require('./setup/seedFixture');

const CREATE = '/api/orders';
const getRoute = (id) => `/api/orders/${id}`;

// 24-character hex strings, deliberately outside every id block seedFixture.js declares, so
// they name nothing in the seeded database.
const UNUSED_ITEM_ID = '00000000000000000000ff30';
const UNUSED_LOCATION_ID = '00000000000000000000ff31';
const UNKNOWN_ORDER_ID = '00000000000000000000ff32';

const post = async (route, body, role = 'SalesUser') =>
    agent()
        .post(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`)
        .send(body);

const get = async (route, role = 'SalesUser') =>
    agent()
        .get(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`);

/** Creates a Customer_Order with sensible defaults, overridable per test. */
const createOrder = (overrides = {}) =>
    post(CREATE, {
        customerName: 'Fixture Customer',
        item: FIXTURE_ITEMS.widget.id,
        location: FIXTURE_LOCATIONS.main.id,
        quantity: 1,
        ...overrides,
    });

/** Reads back one Inventory_Record by its natural key, or null when none exists. */
const findRecord = (item, location, batch) =>
    InventoryRecord.findOne({ item, location, batch }).lean();

describe('POST /api/orders -- mandatory test 1: reservation above availability (Req 7.3, 12.1)', () => {
    test('a quantity above Location_Available_Quantity is rejected 409 INSUFFICIENT_AVAILABLE_QUANTITY, no order created, every affected record unchanged', async () => {
        // widgetMainBatchA (available 70) + widgetMainBatchB (available 50) sum to a
        // Location_Available_Quantity of 120 for widget at main. A quantity of 121 exceeds
        // that total, but only after both batches have been fully consumed inside the
        // reservation loop, so this exercises the rollback of every batch the transaction
        // touched, not just the first (Req 7.1, 7.3, 8.2).
        const beforeA = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id, 'A');
        const beforeB = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id, 'B');

        const response = await createOrder({ quantity: 121 });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INSUFFICIENT_AVAILABLE_QUANTITY',
            message: expect.any(String),
        });

        expect(await CustomerOrder.find({}).lean()).toEqual([]);

        const afterA = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id, 'A');
        const afterB = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id, 'B');
        expect(afterA.reservedQuantity).toBe(beforeA.reservedQuantity);
        expect(afterB.reservedQuantity).toBe(beforeB.reservedQuantity);
    });
});

describe('POST /api/orders -- reservation allocation (Req 7.1, 7.2, 7.10)', () => {
    test('reserving 60 of an available 100 leaves physical 100, reserved 60, available 40', async () => {
        const setup = await post(
            '/api/inventory',
            {
                item: FIXTURE_ITEMS.gadget.id,
                location: FIXTURE_LOCATIONS.main.id,
                batch: 'ALLOC-TEST',
                physicalQuantity: 100,
                movementReference: 'order-test-allocation-setup',
            },
            'Admin'
        );
        expect(setup.status).toBe(201);

        const response = await createOrder({
            item: FIXTURE_ITEMS.gadget.id,
            location: FIXTURE_LOCATIONS.main.id,
            quantity: 60,
        });

        expect(response.status).toBe(201);

        const stored = await findRecord(FIXTURE_ITEMS.gadget.id, FIXTURE_LOCATIONS.main.id, 'ALLOC-TEST');
        expect(stored.physicalQuantity).toBe(100);
        expect(stored.reservedQuantity).toBe(60);
        expect(stored.physicalQuantity - stored.reservedQuantity).toBe(40);
    });

    test('a reservation spanning two batches consumes the earlier batch fully before touching the later one, in ascending batch order', async () => {
        // A fresh item/location pair -- widget has no Inventory_Record at `secondary` in the
        // fixture -- so this test's own two batches are the only candidates
        // reserveAcrossBatches can see, and the split it produces is unambiguous.
        const batchP = await post(
            '/api/inventory',
            {
                item: FIXTURE_ITEMS.widget.id,
                location: FIXTURE_LOCATIONS.secondary.id,
                batch: 'P',
                physicalQuantity: 10,
                movementReference: 'order-test-multibatch-p',
            },
            'Admin'
        );
        expect(batchP.status).toBe(201);

        const batchQ = await post(
            '/api/inventory',
            {
                item: FIXTURE_ITEMS.widget.id,
                location: FIXTURE_LOCATIONS.secondary.id,
                batch: 'Q',
                physicalQuantity: 100,
                movementReference: 'order-test-multibatch-q',
            },
            'Admin'
        );
        expect(batchQ.status).toBe(201);

        const response = await createOrder({
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.secondary.id,
            quantity: 15,
        });

        expect(response.status).toBe(201);
        // Batch P (available 10) is fully consumed before batch Q is touched at all: 10 from
        // P, then the remaining 5 from Q, in that order (Req 7.1).
        expect(response.body.reservations).toEqual([
            { item: FIXTURE_ITEMS.widget.id, location: FIXTURE_LOCATIONS.secondary.id, batch: 'P', quantity: 10 },
            { item: FIXTURE_ITEMS.widget.id, location: FIXTURE_LOCATIONS.secondary.id, batch: 'Q', quantity: 5 },
        ]);

        const storedP = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.secondary.id, 'P');
        expect(storedP.reservedQuantity).toBe(10);
        const storedQ = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.secondary.id, 'Q');
        expect(storedQ.reservedQuantity).toBe(5);

        // One ledger row per changed record beyond its opening row.
        const rowsP = await InventoryTransaction.find({ inventoryRecord: batchP.body.id });
        expect(rowsP).toHaveLength(2);
        const rowsQ = await InventoryTransaction.find({ inventoryRecord: batchQ.body.id });
        expect(rowsQ).toHaveLength(2);
    });

    test.each([
        ['an unknown item', { item: UNUSED_ITEM_ID }],
        ['an unknown location', { location: UNUSED_LOCATION_ID }],
    ])('%s is rejected 400 INVALID_REFERENCE, no order created', async (_label, refs) => {
        const before = await CustomerOrder.find({}).lean();

        const response = await createOrder(refs);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'INVALID_REFERENCE', message: expect.any(String) });
        expect(await CustomerOrder.find({}).lean()).toEqual(before);
    });

    test.each([
        ['a blank customer name', ''],
        ['a whitespace-only customer name', '   '],
        ['a missing customer name', undefined],
    ])('%s is rejected 400 VALIDATION_ERROR, no order created', async (_label, customerName) => {
        const before = await CustomerOrder.find({}).lean();
        const body = {
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.main.id,
            quantity: 1,
        };
        if (customerName !== undefined) body.customerName = customerName;

        const response = await post(CREATE, body);

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(await CustomerOrder.find({}).lean()).toEqual(before);
    });

    test.each([
        ['zero', 0],
        ['negative', -5],
        ['not a whole number', 4.5],
        ['above the 1,000,000 ceiling', 1_000_001],
    ])('a quantity that is %s is rejected 400 INVALID_QUANTITY, no order created', async (_label, quantity) => {
        const before = await CustomerOrder.find({}).lean();

        const response = await createOrder({ quantity });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_QUANTITY');
        expect(await CustomerOrder.find({}).lean()).toEqual(before);
    });

    test('an unmatched order id on GET /api/orders/:id is rejected 404 NOT_FOUND', async () => {
        const response = await get(getRoute(UNKNOWN_ORDER_ID));

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    });
});

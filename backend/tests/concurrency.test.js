// backend/tests/concurrency.test.js -- the mandatory concurrency tests: two genuinely
// concurrent order-creation requests racing for the same InventoryRecord's availability, and
// two genuinely concurrent receipt requests racing to receive the same InternalTransfer (Req
// 6.16, 7.5, 7.6, 7.7, 12.6, 12.13).
//
// Every assertion is made over real HTTP against the exported app, so `validate`,
// `authorize`, the controllers, `order.service.js`, and `transfer.service.js` all run inside
// each assertion (Req 12.13).
//
// "Genuinely concurrent" here means both requests are built as supertest `Test` objects
// first, and only THEN handed to `Promise.allSettled` together -- neither request is
// awaited on its own before the other is constructed. `Promise.allSettled` calls `.then()`
// on each array entry synchronously as it iterates, which is what actually dispatches a
// supertest `Test` object's underlying HTTP request, so both requests are in flight before
// either one's response arrives.

const CustomerOrder = require('../src/models/CustomerOrder');
const InventoryRecord = require('../src/models/InventoryRecord');
const InternalTransfer = require('../src/models/InternalTransfer');
const { agent } = require('./setup/agent');
const { FIXTURE_ITEMS, FIXTURE_LOCATIONS, tokenFor } = require('./setup/seedFixture');

const CREATE_ORDER = '/api/orders';
const CREATE_TRANSFER = '/api/transfers';
const dispatchRoute = (id) => `/api/transfers/${id}/dispatch`;
const receiveRoute = (id) => `/api/transfers/${id}/receive`;

const post = async (route, body, role) =>
    agent()
        .post(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`)
        .send(body);

/** Reads back one Inventory_Record by its natural key, or null when none exists. */
const findRecord = (item, location, batch) =>
    InventoryRecord.findOne({ item, location, batch }).lean();

describe('Concurrent customer order creation for the same item/location (Req 7.5, 7.6, 7.7, 12.6)', () => {
    test('of two unawaited requests for 80 and 50 against an availability of 100, exactly one commits', async () => {
        // A fresh Inventory_Record with an exact, known Available_Quantity of 100: widget has
        // no record at `secondary` in the fixture, so this batch is the only candidate the
        // reservation loop can see for this item/location pair.
        const setup = await post(
            '/api/inventory',
            {
                item: FIXTURE_ITEMS.widget.id,
                location: FIXTURE_LOCATIONS.secondary.id,
                batch: 'CONC-ORDER',
                physicalQuantity: 100,
                movementReference: 'concurrency-test-order-setup',
            },
            'Admin'
        );
        expect(setup.status).toBe(201);

        // Both requests are built (not sent) before either is awaited. A single pre-fetched
        // token is reused for both, so no token fetch delays one request relative to the
        // other.
        const token = await tokenFor('SalesUser');
        const quantities = [80, 50];
        const requests = quantities.map((quantity) =>
            agent()
                .post(CREATE_ORDER)
                .set('Authorization', `Bearer ${token}`)
                .send({
                    customerName: 'Concurrency Race Customer',
                    item: FIXTURE_ITEMS.widget.id,
                    location: FIXTURE_LOCATIONS.secondary.id,
                    quantity,
                })
        );

        // `Promise.allSettled` dispatches both underlying HTTP requests as it iterates,
        // before either one's response has arrived.
        const settled = await Promise.allSettled(requests);
        const responses = settled.map((outcome) => {
            if (outcome.status !== 'fulfilled') throw outcome.reason;
            return outcome.value;
        });

        const committed = responses.filter((response) => response.status === 201);
        const rejected = responses.filter((response) => response.status === 409);

        expect(committed).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].body).toEqual({
            code: 'INSUFFICIENT_AVAILABLE_QUANTITY',
            message: expect.any(String),
        });

        // Exactly one Customer_Order exists for this item/location pair -- the winner's.
        const orders = await CustomerOrder.find({
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.secondary.id,
        }).lean();
        expect(orders).toHaveLength(1);

        // The committed quantity is whichever one won the race -- 80 or 50 -- and the record
        // started at reservedQuantity 0, so the total increase equals the winner's quantity
        // exactly (no oversell, no undersell).
        const winningIndex = responses.findIndex((response) => response.status === 201);
        const winningQuantity = quantities[winningIndex];
        expect(orders[0].quantity).toBe(winningQuantity);

        const record = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.secondary.id, 'CONC-ORDER');
        expect(record.reservedQuantity).toBe(winningQuantity);
    });
});

describe('Concurrent receipt of the same internal transfer (Req 6.16, 12.6)', () => {
    test('of two unawaited receive requests for one Dispatched transfer, exactly one commits', async () => {
        // A fresh transfer of an existing fixture batch (widgetMainBatchA: available 70 at
        // `main`), already dispatched -- sequentially, since only the receipt itself is the
        // race under test.
        const created = await post(
            CREATE_TRANSFER,
            {
                item: FIXTURE_ITEMS.widget.id,
                batch: 'A',
                sourceLocation: FIXTURE_LOCATIONS.main.id,
                destinationLocation: FIXTURE_LOCATIONS.secondary.id,
                quantity: 20,
            },
            'OperationsUser'
        );
        expect(created.status).toBe(201);
        const transferId = created.body.id;

        const dispatch = await post(dispatchRoute(transferId), {}, 'OperationsUser');
        expect(dispatch.status).toBe(200);

        // Both receipt requests are built before either is awaited, with a single
        // pre-fetched token shared by both.
        const token = await tokenFor('OperationsUser');
        const requests = [1, 2].map(() =>
            agent().post(receiveRoute(transferId)).set('Authorization', `Bearer ${token}`).send({})
        );

        const settled = await Promise.allSettled(requests);
        const responses = settled.map((outcome) => {
            if (outcome.status !== 'fulfilled') throw outcome.reason;
            return outcome.value;
        });

        const committed = responses.filter((response) => response.status === 200);
        const rejected = responses.filter((response) => response.status === 409);

        expect(committed).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].body).toEqual({
            code: 'TRANSFER_ALREADY_RECEIVED',
            message: expect.any(String),
        });

        const storedTransfer = await InternalTransfer.findById(transferId).lean();
        expect(storedTransfer.status).toBe('Received');

        // Exactly one receipt applied: the destination physicalQuantity equals the transfer
        // quantity exactly -- not 0 (no receipt applied) and not 40 (applied twice).
        const destination = await findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.secondary.id, 'A');
        expect(destination.physicalQuantity).toBe(20);
    });
});

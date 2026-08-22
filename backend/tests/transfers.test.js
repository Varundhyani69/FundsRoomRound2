// backend/tests/transfers.test.js -- internal transfer dispatch/receipt behavior and
// creation guards (Req 6.1-6.15, 12.2, 12.3, 12.4, 12.13).
//
// Every assertion is made over real HTTP against the exported app, so `validate`,
// `authorize`, the controller and `transfer.service.js` all run inside each assertion
// (Req 12.13). The full role x route matrix for every write route lives in
// authorization.test.js and src/permissions.js, so this file does not repeat it.

const InternalTransfer = require('../src/models/InternalTransfer');
const InventoryRecord = require('../src/models/InventoryRecord');
const { agent } = require('./setup/agent');
const {
    FIXTURE_ITEMS,
    FIXTURE_LOCATIONS,
    FIXTURE_INVENTORY_RECORDS,
    tokenFor,
} = require('./setup/seedFixture');

const CREATE = '/api/transfers';
const dispatchRoute = (id) => `/api/transfers/${id}/dispatch`;
const receiveRoute = (id) => `/api/transfers/${id}/receive`;

// 24-character hex strings, deliberately outside every id block seedFixture.js declares, so
// they name nothing in the seeded database.
const UNUSED_ITEM_ID = '00000000000000000000ff20';
const UNUSED_LOCATION_ID = '00000000000000000000ff21';
const UNKNOWN_TRANSFER_ID = '00000000000000000000ff22';

const post = async (route, body, role = 'OperationsUser') =>
    agent()
        .post(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`)
        .send(body);

/** Creates an Internal_Transfer with sensible defaults, overridable per test. */
const createTransfer = (overrides = {}) =>
    post(CREATE, {
        item: FIXTURE_ITEMS.widget.id,
        batch: 'A',
        sourceLocation: FIXTURE_LOCATIONS.main.id,
        destinationLocation: FIXTURE_LOCATIONS.secondary.id,
        quantity: 5,
        ...overrides,
    });

/** Reads back one Inventory_Record by its natural key, or null when none exists. */
const findRecord = (item, location, batch) =>
    InventoryRecord.findOne({ item, location, batch }).lean();

describe('POST /api/transfers/:id/dispatch -- mandatory test 2: over-availability dispatch (Req 6.5, 12.2)', () => {
    test('a quantity above source Available_Quantity is rejected 409 INSUFFICIENT_AVAILABLE_QUANTITY, source unchanged, status stays Requested', async () => {
        // widgetMainBatchA: physical 100, reserved 30 -> available 70. A quantity of 71
        // exceeds Available_Quantity but not Physical_Quantity, so this specifically
        // exercises Req 6.5's INSUFFICIENT_AVAILABLE_QUANTITY branch rather than the
        // INSUFFICIENT_PHYSICAL_QUANTITY branch a naive guard could report instead.
        const fixtureRecord = FIXTURE_INVENTORY_RECORDS.widgetMainBatchA;
        const created = await createTransfer({
            item: FIXTURE_ITEMS.widget.id,
            batch: fixtureRecord.batch,
            sourceLocation: FIXTURE_LOCATIONS.main.id,
            destinationLocation: FIXTURE_LOCATIONS.secondary.id,
            quantity: 71,
        });
        expect(created.status).toBe(201);
        const transferId = created.body.id;

        const beforeDispatch = await findRecord(
            FIXTURE_ITEMS.widget.id,
            FIXTURE_LOCATIONS.main.id,
            fixtureRecord.batch
        );
        expect(beforeDispatch.physicalQuantity).toBe(fixtureRecord.physicalQuantity);

        const response = await post(dispatchRoute(transferId), {});

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INSUFFICIENT_AVAILABLE_QUANTITY',
            message: expect.any(String),
        });

        const afterDispatch = await findRecord(
            FIXTURE_ITEMS.widget.id,
            FIXTURE_LOCATIONS.main.id,
            fixtureRecord.batch
        );
        expect(afterDispatch.physicalQuantity).toBe(beforeDispatch.physicalQuantity);

        const storedTransfer = await InternalTransfer.findById(transferId).lean();
        expect(storedTransfer.status).toBe('Requested');
    });
});

describe('Internal transfer lifecycle -- mandatory test 3: three-point destination reading (Req 6.3, 6.6, 6.7, 12.3)', () => {
    test('destination Physical_Quantity is unchanged through dispatch and rises by the transfer Quantity after receipt', async () => {
        // A fresh destination record with a known, exact Physical_Quantity, so the "before
        // dispatch" reading is a value this test chose rather than something derived from
        // other fixture arithmetic.
        const destinationSetup = await post('/api/inventory', {
            item: FIXTURE_ITEMS.widget.id,
            location: FIXTURE_LOCATIONS.secondary.id,
            batch: 'B',
            physicalQuantity: 15,
            movementReference: 'transfer-test-destination-setup',
        });
        expect(destinationSetup.status).toBe(201);

        // Source: widgetMainBatchB (physical 50, reserved 0 -> available 50), same batch
        // 'B' as the destination record above, so the transfer moves the same batch of the
        // same item between the two locations.
        const transferQuantity = 10;
        const created = await createTransfer({
            item: FIXTURE_ITEMS.widget.id,
            batch: 'B',
            sourceLocation: FIXTURE_LOCATIONS.main.id,
            destinationLocation: FIXTURE_LOCATIONS.secondary.id,
            quantity: transferQuantity,
        });
        expect(created.status).toBe(201);
        const transferId = created.body.id;

        const readDestination = () =>
            findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.secondary.id, 'B');

        const beforeDispatch = await readDestination();
        expect(beforeDispatch.physicalQuantity).toBe(15);

        const dispatch = await post(dispatchRoute(transferId), {});
        expect(dispatch.status).toBe(200);
        expect(dispatch.body.status).toBe('Dispatched');

        const whileDispatched = await readDestination();
        expect(whileDispatched.physicalQuantity).toBe(beforeDispatch.physicalQuantity);

        const receive = await post(receiveRoute(transferId), {});
        expect(receive.status).toBe(200);
        expect(receive.body.status).toBe('Received');

        const afterReceived = await readDestination();
        expect(afterReceived.physicalQuantity).toBe(beforeDispatch.physicalQuantity + transferQuantity);
    });
});

describe('POST /api/transfers/:id/receive -- mandatory test 4: second receipt rejected (Req 6.9, 12.4)', () => {
    test('a second receipt against an already-Received transfer is rejected 409 TRANSFER_ALREADY_RECEIVED, destination unchanged', async () => {
        const created = await createTransfer({
            item: FIXTURE_ITEMS.widget.id,
            batch: 'B',
            sourceLocation: FIXTURE_LOCATIONS.main.id,
            destinationLocation: FIXTURE_LOCATIONS.secondary.id,
            quantity: 10,
        });
        expect(created.status).toBe(201);
        const transferId = created.body.id;

        const dispatch = await post(dispatchRoute(transferId), {});
        expect(dispatch.status).toBe(200);

        const firstReceive = await post(receiveRoute(transferId), {});
        expect(firstReceive.status).toBe(200);

        const readDestination = () =>
            findRecord(FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.secondary.id, 'B');
        const afterFirstReceive = await readDestination();

        const secondReceive = await post(receiveRoute(transferId), {});

        expect(secondReceive.status).toBe(409);
        expect(secondReceive.body).toEqual({
            code: 'TRANSFER_ALREADY_RECEIVED',
            message: expect.any(String),
        });

        const afterSecondReceive = await readDestination();
        expect(afterSecondReceive.physicalQuantity).toBe(afterFirstReceive.physicalQuantity);
    });
});

describe('POST /api/transfers -- creation guards (Req 6.2, 6.10, 6.13, 6.14, 6.15)', () => {
    test('a destination equal to the source is rejected 400 SAME_LOCATION_TRANSFER, no transfer created', async () => {
        const before = await InternalTransfer.find({}).lean();

        const response = await createTransfer({
            sourceLocation: FIXTURE_LOCATIONS.main.id,
            destinationLocation: FIXTURE_LOCATIONS.main.id,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'SAME_LOCATION_TRANSFER', message: expect.any(String) });
        expect(await InternalTransfer.find({}).lean()).toEqual(before);
    });

    test.each([
        [
            'an unknown item',
            {
                item: UNUSED_ITEM_ID,
                sourceLocation: FIXTURE_LOCATIONS.main.id,
                destinationLocation: FIXTURE_LOCATIONS.secondary.id,
            },
        ],
        [
            'an unknown source location',
            {
                sourceLocation: UNUSED_LOCATION_ID,
                destinationLocation: FIXTURE_LOCATIONS.secondary.id,
            },
        ],
        [
            'an unknown destination location',
            {
                sourceLocation: FIXTURE_LOCATIONS.main.id,
                destinationLocation: UNUSED_LOCATION_ID,
            },
        ],
    ])('%s is rejected 400 INVALID_REFERENCE, no transfer created', async (_label, refs) => {
        const before = await InternalTransfer.find({}).lean();

        const response = await createTransfer(refs);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'INVALID_REFERENCE', message: expect.any(String) });
        expect(await InternalTransfer.find({}).lean()).toEqual(before);
    });

    test('an unknown source batch, with the item and location each individually existing, is rejected 400 INVALID_REFERENCE (Req 6.14)', async () => {
        const before = await InternalTransfer.find({}).lean();

        // gadget exists, main exists, but no Inventory_Record for { gadget, main, * } --
        // the fixture only seeds gadgetSecondaryLow at `secondary`.
        const response = await createTransfer({
            item: FIXTURE_ITEMS.gadget.id,
            batch: 'NO-SUCH-BATCH',
            sourceLocation: FIXTURE_LOCATIONS.main.id,
            destinationLocation: FIXTURE_LOCATIONS.secondary.id,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'INVALID_REFERENCE', message: expect.any(String) });
        expect(await InternalTransfer.find({}).lean()).toEqual(before);
    });

    test.each([
        ['zero', 0],
        ['negative', -5],
        ['not a whole number', 4.5],
        ['above the 1,000,000 ceiling', 1_000_001],
    ])('a quantity that is %s is rejected 400 INVALID_QUANTITY, no transfer created', async (_label, quantity) => {
        const before = await InternalTransfer.find({}).lean();

        const response = await createTransfer({ quantity });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_QUANTITY');
        expect(await InternalTransfer.find({}).lean()).toEqual(before);
    });

    test('dispatching an unknown transfer id is rejected 404 NOT_FOUND', async () => {
        const response = await post(dispatchRoute(UNKNOWN_TRANSFER_ID), {});

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    });

    test('receiving an unknown transfer id is rejected 404 NOT_FOUND', async () => {
        const response = await post(receiveRoute(UNKNOWN_TRANSFER_ID), {});

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    });

    test('dispatching an already-Dispatched transfer is rejected 409 INVALID_STATUS_TRANSITION', async () => {
        const created = await createTransfer();
        const transferId = created.body.id;
        const firstDispatch = await post(dispatchRoute(transferId), {});
        expect(firstDispatch.status).toBe(200);

        const response = await post(dispatchRoute(transferId), {});

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INVALID_STATUS_TRANSITION',
            message: expect.any(String),
        });
    });

    test('dispatching an already-Received transfer is rejected 409 INVALID_STATUS_TRANSITION', async () => {
        const created = await createTransfer();
        const transferId = created.body.id;
        await post(dispatchRoute(transferId), {});
        const received = await post(receiveRoute(transferId), {});
        expect(received.status).toBe(200);

        const response = await post(dispatchRoute(transferId), {});

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INVALID_STATUS_TRANSITION',
            message: expect.any(String),
        });
    });

    test('receiving a still-Requested transfer is rejected 409 INVALID_STATUS_TRANSITION, not TRANSFER_ALREADY_RECEIVED', async () => {
        const created = await createTransfer();
        const transferId = created.body.id;

        const response = await post(receiveRoute(transferId), {});

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INVALID_STATUS_TRANSITION',
            message: expect.any(String),
        });
    });
});

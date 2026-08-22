// backend/tests/workOrders.test.js -- work order creation, read-time shortage derivation,
// and guarded status transitions (Req 5.1, 5.5, 5.6, 5.7, 5.9, 5.11, 5.12).
//
// Every assertion is made over real HTTP against the exported app, so `validate`,
// `authorize`, the controller and `workOrder.service.js` all run inside each assertion
// (Req 12.13). The full role x route matrix for every write route lives in
// authorization.test.js and src/permissions.js; the one check at the bottom of this file
// only confirms POST /api/work-orders is actually wired into that map, the same spot-check
// pattern inventory.test.js uses.

const WorkOrder = require('../src/models/WorkOrder');
const { agent } = require('./setup/agent');
const {
    FIXTURE_ITEMS,
    FIXTURE_LOCATIONS,
    FIXTURE_USERS,
    tokenFor,
} = require('./setup/seedFixture');

const CREATE = '/api/work-orders';
const getRoute = (id) => `/api/work-orders/${id}`;
const statusRoute = (id) => `/api/work-orders/${id}/status`;

// 24-character hex string, deliberately outside every id block seedFixture.js declares, so
// it names no existing Work_Order.
const UNKNOWN_WORK_ORDER_ID = '00000000000000000000ff09';

const post = async (route, body, role = 'Admin') =>
    agent()
        .post(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`)
        .send(body);

const patch = async (route, body, role = 'Admin') =>
    agent()
        .patch(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`)
        .send(body);

const get = async (route, role = 'Admin') =>
    agent()
        .get(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`);

/** Creates a Work_Order for `widget` at `main`, defaulting requiredQuantity to 1. */
const createWorkOrder = (requiredQuantity = 1) =>
    post(CREATE, {
        location: FIXTURE_LOCATIONS.main.id,
        item: FIXTURE_ITEMS.widget.id,
        requiredQuantity,
        assignedUser: FIXTURE_USERS.OperationsUser.id,
    });

describe('POST /api/work-orders -- creation and shortage derivation (Req 5.1, 5.4, 5.5, 5.6)', () => {
    test('201s with the documented shape, status Assigned, and a derived shortageQuantity', async () => {
        const response = await createWorkOrder(10);

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            id: expect.any(String),
            location: {
                id: FIXTURE_LOCATIONS.main.id,
                code: 'MAIN',
                name: FIXTURE_LOCATIONS.main.name,
            },
            item: {
                id: FIXTURE_ITEMS.widget.id,
                code: 'WIDGET',
                name: FIXTURE_ITEMS.widget.name,
                category: { id: FIXTURE_ITEMS.widget.category, name: 'Raw Material' },
            },
            requiredQuantity: 10,
            assignedUser: {
                id: FIXTURE_USERS.OperationsUser.id,
                email: FIXTURE_USERS.OperationsUser.email,
                role: 'OperationsUser',
            },
            status: 'Assigned',
            statusChangedAt: null,
            locationAvailableQuantity: expect.any(Number),
            shortageQuantity: expect.any(Number),
            createdAt: expect.any(String),
        });
    });

    // widgetMainBatchA (physical 100, reserved 30 -> available 70) plus widgetMainBatchB
    // (physical 50, reserved 0 -> available 50) sum to a Location_Available_Quantity of
    // 120 for widget at main. A requiredQuantity of 100 is below that, so this test creates
    // its own, separate inventory shortfall first: a fresh record whose available quantity
    // is exactly 60, so requiredQuantity 100 against it reports shortageQuantity 40 exactly
    // (Req 5.5).
    test('required 100 vs Location_Available_Quantity 60 -> shortageQuantity 40', async () => {
        const created = await post('/api/inventory', {
            item: FIXTURE_ITEMS.gadget.id,
            location: FIXTURE_LOCATIONS.main.id,
            batch: 'SHORTAGE-TEST',
            physicalQuantity: 60,
            movementReference: 'work-order-test-shortage-setup',
        });
        expect(created.status).toBe(201);

        const response = await post(CREATE, {
            location: FIXTURE_LOCATIONS.main.id,
            item: FIXTURE_ITEMS.gadget.id,
            requiredQuantity: 100,
            assignedUser: FIXTURE_USERS.OperationsUser.id,
        });

        expect(response.status).toBe(201);
        expect(response.body.locationAvailableQuantity).toBe(60);
        expect(response.body.shortageQuantity).toBe(40);
    });

    // Surplus case (Req 5.6): requiredQuantity at or below the available quantity reports a
    // shortageQuantity of 0. widget at main already has 120 available from the fixture, so
    // a requiredQuantity of 50 is comfortably covered.
    test('required 50 vs Location_Available_Quantity 120 -> shortageQuantity 0', async () => {
        const response = await createWorkOrder(50);

        expect(response.status).toBe(201);
        expect(response.body.locationAvailableQuantity).toBe(120);
        expect(response.body.shortageQuantity).toBe(0);
    });

    test('an unknown location reference is rejected 400 INVALID_REFERENCE, no Work_Order created', async () => {
        const before = await WorkOrder.find({}).lean();

        const response = await post(CREATE, {
            location: UNKNOWN_WORK_ORDER_ID,
            item: FIXTURE_ITEMS.widget.id,
            requiredQuantity: 5,
            assignedUser: FIXTURE_USERS.OperationsUser.id,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'INVALID_REFERENCE', message: expect.any(String) });
        expect(await WorkOrder.find({}).lean()).toEqual(before);
    });

    test('an unknown item reference is rejected 400 INVALID_REFERENCE, no Work_Order created', async () => {
        const before = await WorkOrder.find({}).lean();

        const response = await post(CREATE, {
            location: FIXTURE_LOCATIONS.main.id,
            item: UNKNOWN_WORK_ORDER_ID,
            requiredQuantity: 5,
            assignedUser: FIXTURE_USERS.OperationsUser.id,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'INVALID_REFERENCE', message: expect.any(String) });
        expect(await WorkOrder.find({}).lean()).toEqual(before);
    });

    test('an unknown assignedUser reference is rejected 400 INVALID_REFERENCE, no Work_Order created', async () => {
        const before = await WorkOrder.find({}).lean();

        const response = await post(CREATE, {
            location: FIXTURE_LOCATIONS.main.id,
            item: FIXTURE_ITEMS.widget.id,
            requiredQuantity: 5,
            assignedUser: UNKNOWN_WORK_ORDER_ID,
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: 'INVALID_REFERENCE', message: expect.any(String) });
        expect(await WorkOrder.find({}).lean()).toEqual(before);
    });

    test.each([
        ['zero', 0],
        ['negative', -5],
        ['not a whole number', 4.5],
        ['above the 1,000,000 ceiling', 1_000_001],
    ])('a requiredQuantity that is %s is rejected 400 INVALID_QUANTITY, no Work_Order created', async (_label, requiredQuantity) => {
        const before = await WorkOrder.find({}).lean();

        const response = await post(CREATE, {
            location: FIXTURE_LOCATIONS.main.id,
            item: FIXTURE_ITEMS.widget.id,
            requiredQuantity,
            assignedUser: FIXTURE_USERS.OperationsUser.id,
        });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_QUANTITY');
        expect(await WorkOrder.find({}).lean()).toEqual(before);
    });

    test('a SalesUser token is denied 403 FORBIDDEN on POST /api/work-orders', async () => {
        const before = await WorkOrder.find({}).lean();

        const response = await post(
            CREATE,
            {
                location: FIXTURE_LOCATIONS.main.id,
                item: FIXTURE_ITEMS.widget.id,
                requiredQuantity: 5,
                assignedUser: FIXTURE_USERS.OperationsUser.id,
            },
            'SalesUser'
        );

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ code: 'FORBIDDEN', message: expect.any(String) });
        expect(await WorkOrder.find({}).lean()).toEqual(before);
    });

    test('an OperationsUser token is denied 403 FORBIDDEN on POST /api/work-orders', async () => {
        const response = await post(
            CREATE,
            {
                location: FIXTURE_LOCATIONS.main.id,
                item: FIXTURE_ITEMS.widget.id,
                requiredQuantity: 5,
                assignedUser: FIXTURE_USERS.OperationsUser.id,
            },
            'OperationsUser'
        );

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ code: 'FORBIDDEN', message: expect.any(String) });
    });
});

describe('PATCH /api/work-orders/:id/status -- guarded transitions (Req 5.7, 5.8, 5.9)', () => {
    test('Assigned -> InProgress -> Completed are each accepted with a recorded statusChangedAt', async () => {
        const created = await createWorkOrder(5);
        const id = created.body.id;

        const toInProgress = await patch(statusRoute(id), { status: 'InProgress' });
        expect(toInProgress.status).toBe(200);
        expect(toInProgress.body.status).toBe('InProgress');
        expect(toInProgress.body.statusChangedAt).not.toBeNull();

        const toCompleted = await patch(statusRoute(id), { status: 'Completed' });
        expect(toCompleted.status).toBe(200);
        expect(toCompleted.body.status).toBe('Completed');
        expect(toCompleted.body.statusChangedAt).not.toBeNull();
    });

    test('a same-status repeat (Assigned -> Assigned) is rejected 409 INVALID_STATUS_TRANSITION, status unchanged', async () => {
        const created = await createWorkOrder(5);
        const id = created.body.id;

        const response = await patch(statusRoute(id), { status: 'Assigned' });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INVALID_STATUS_TRANSITION',
            message: expect.any(String),
        });

        const stored = await WorkOrder.findById(id).lean();
        expect(stored.status).toBe('Assigned');
        expect(stored.statusChangedAt).toBeNull();
    });

    test('a backward transition (InProgress -> Assigned) is rejected 409 INVALID_STATUS_TRANSITION, status unchanged', async () => {
        const created = await createWorkOrder(5);
        const id = created.body.id;
        const advance = await patch(statusRoute(id), { status: 'InProgress' });
        expect(advance.status).toBe(200);

        const response = await patch(statusRoute(id), { status: 'Assigned' });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INVALID_STATUS_TRANSITION',
            message: expect.any(String),
        });

        const stored = await WorkOrder.findById(id).lean();
        expect(stored.status).toBe('InProgress');
    });

    test('a skip-ahead transition (Assigned -> Completed) is rejected 409 INVALID_STATUS_TRANSITION, status unchanged', async () => {
        const created = await createWorkOrder(5);
        const id = created.body.id;

        const response = await patch(statusRoute(id), { status: 'Completed' });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INVALID_STATUS_TRANSITION',
            message: expect.any(String),
        });

        const stored = await WorkOrder.findById(id).lean();
        expect(stored.status).toBe('Assigned');
        expect(stored.statusChangedAt).toBeNull();
    });

    test.each([
        ['Assigned', 'Assigned'],
        ['InProgress', 'InProgress'],
        ['Completed', 'Completed'],
    ])('any transition attempted from the terminal Completed status is rejected 409 INVALID_STATUS_TRANSITION', async (_label, target) => {
        const created = await createWorkOrder(5);
        const id = created.body.id;
        await patch(statusRoute(id), { status: 'InProgress' });
        const toCompleted = await patch(statusRoute(id), { status: 'Completed' });
        expect(toCompleted.status).toBe(200);

        const response = await patch(statusRoute(id), { status: target });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'INVALID_STATUS_TRANSITION',
            message: expect.any(String),
        });

        const stored = await WorkOrder.findById(id).lean();
        expect(stored.status).toBe('Completed');
    });

    test('an out-of-enum status value is rejected 400 VALIDATION_ERROR, status unchanged', async () => {
        const created = await createWorkOrder(5);
        const id = created.body.id;

        const response = await patch(statusRoute(id), { status: 'Cancelled' });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');

        const stored = await WorkOrder.findById(id).lean();
        expect(stored.status).toBe('Assigned');
    });

    test('an unknown work order id is rejected 404 NOT_FOUND', async () => {
        const response = await patch(statusRoute(UNKNOWN_WORK_ORDER_ID), { status: 'InProgress' });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    });
});

describe('GET /api/work-orders/:id -- reads (Req 5.12)', () => {
    test('an unknown work order id is rejected 404 NOT_FOUND', async () => {
        const response = await get(getRoute(UNKNOWN_WORK_ORDER_ID));

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    });

    test('reads back a created Work_Order with the same derived shortage', async () => {
        const created = await createWorkOrder(10);
        const id = created.body.id;

        const response = await get(getRoute(id));

        expect(response.status).toBe(200);
        expect(response.body).toEqual(created.body);
    });
});

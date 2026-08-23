// backend/tests/reference.test.js -- the three read-only reference lists
// (Req 2.13, 3.2).
//
// Everything here goes over real HTTP against the exported app, so `authenticate`,
// `authorize`, the controller and `errorHandler` all run inside each assertion
// (Req 12.13). The rows come from the per-test seed fixture, which dbSetup.js loads
// fresh before every test, so the expected lists below are exact rather than
// "contains".

const jwt = require('jsonwebtoken');
const { User } = require('./setup/tables');

const config = require('../src/config');
const { ROLES } = require('../src/permissions');
const { agent } = require('./setup/agent');
const {
    FIXTURE_USERS,
    FIXTURE_LOCATIONS,
    FIXTURE_ITEMS,
    tokenFor,
} = require('./setup/seedFixture');

// The three routes, so the token checks below can run the same assertion over each
// of them instead of repeating it three times.
const ROUTES = ['/api/items', '/api/locations', '/api/users'];

// The documented response shapes, in the order each controller sorts by.
// Items and Locations sort by `code` ascending, Users by `email` ascending.
const EXPECTED_ITEMS = [
    {
        id: FIXTURE_ITEMS.gadget.id,
        code: 'GADGET',
        name: FIXTURE_ITEMS.gadget.name,
        category: { id: FIXTURE_ITEMS.gadget.category, name: 'Raw Material' },
    },
    {
        id: FIXTURE_ITEMS.widget.id,
        code: 'WIDGET',
        name: FIXTURE_ITEMS.widget.name,
        category: { id: FIXTURE_ITEMS.widget.category, name: 'Raw Material' },
    },
];

const EXPECTED_LOCATIONS = [
    { id: FIXTURE_LOCATIONS.main.id, code: 'MAIN', name: FIXTURE_LOCATIONS.main.name },
    { id: FIXTURE_LOCATIONS.secondary.id, code: 'SEC', name: FIXTURE_LOCATIONS.secondary.name },
];

const EXPECTED_USERS = [
    { id: FIXTURE_USERS.Admin.id, email: FIXTURE_USERS.Admin.email, role: 'Admin' },
    {
        id: FIXTURE_USERS.OperationsUser.id,
        email: FIXTURE_USERS.OperationsUser.email,
        role: 'OperationsUser',
    },
    { id: FIXTURE_USERS.SalesUser.id, email: FIXTURE_USERS.SalesUser.email, role: 'SalesUser' },
];

const EXPECTED_BY_ROUTE = {
    '/api/items': EXPECTED_ITEMS,
    '/api/locations': EXPECTED_LOCATIONS,
    '/api/users': EXPECTED_USERS,
};

/** GET a route with a token for the named Role. */
const get = (route, token) => agent().get(route).set('Authorization', `Bearer ${token}`);

/** Every key name appearing anywhere in a JSON value, however deeply nested. */
function allKeys(value) {
    if (Array.isArray(value)) {
        return value.flatMap(allKeys);
    }
    if (value !== null && typeof value === 'object') {
        return Object.keys(value).concat(Object.values(value).flatMap(allKeys));
    }
    return [];
}

describe('GET /api/items (Req 3.2)', () => {
    test('returns 200 and exactly the fixture Items, sorted by code', async () => {
        const response = await get('/api/items', await tokenFor('Admin'));

        expect(response.status).toBe(200);
        expect(response.body).toEqual(EXPECTED_ITEMS);
    });

    test('reports the Category as { id, name }, not an embedded copy of the document', async () => {
        const response = await get('/api/items', await tokenFor('Admin'));

        // Exactly the two fields the dropdown needs. A populated copy of the whole
        // Category document would also carry `_id`, `__v` and the timestamps, so
        // asserting the key set is what makes "not a duplicated copy" observable.
        response.body.forEach((item) => {
            expect(Object.keys(item.category).sort()).toEqual(['id', 'name']);
        });
    });

    test('reports the Category as an object, never as a raw ObjectId string', async () => {
        const response = await get('/api/items', await tokenFor('Admin'));

        response.body.forEach((item) => {
            expect(typeof item.category).toBe('object');
            expect(item.category).not.toBeNull();
            // An unpopulated reference would serialise to the bare id string.
            expect(typeof item.category).not.toBe('string');
        });
    });
});

describe('GET /api/locations (Req 3.2)', () => {
    test('returns 200 and exactly the fixture Locations, sorted by code', async () => {
        const response = await get('/api/locations', await tokenFor('Admin'));

        expect(response.status).toBe(200);
        expect(response.body).toEqual(EXPECTED_LOCATIONS);
    });
});

describe('GET /api/users (Req 1.1, 3.2)', () => {
    test('returns 200 and exactly the fixture Users, sorted by email', async () => {
        const response = await get('/api/users', await tokenFor('Admin'));

        expect(response.status).toBe(200);
        expect(response.body).toEqual(EXPECTED_USERS);
    });

    test('exposes no passwordHash under any key, at any depth', async () => {
        const response = await get('/api/users', await tokenFor('Admin'));

        expect(allKeys(response.body)).toEqual(
            expect.not.arrayContaining(['passwordHash', 'password'])
        );
    });

    test('the raw response text contains none of the stored hashes', async () => {
        // Read the hashes as stored, so this compares against the real values rather
        // than against a guess at what a bcrypt hash looks like. No `.select()` is needed:
        // tests/setup/tables.js returns `passwordHash` because it names the column
        // explicitly, whereas the login query is the only place in src/ that does (Req 1.1).
        const stored = await User.find();
        expect(stored).toHaveLength(EXPECTED_USERS.length);

        const response = await get('/api/users', await tokenFor('Admin'));

        expect(response.status).toBe(200);
        stored.forEach((user) => {
            expect(user.passwordHash).toEqual(expect.any(String));
            expect(response.text).not.toContain(user.passwordHash);
        });
    });
});

describe('a reference list request with no token (Req 1.8)', () => {
    test.each(ROUTES)('GET %s is answered 401 UNAUTHENTICATED', async (route) => {
        const response = await agent().get(route);

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ code: 'UNAUTHENTICATED', message: expect.any(String) });
    });
});

describe('reads pass for every declared Role (Req 2.13)', () => {
    const pairs = ROUTES.flatMap((route) => ROLES.map((role) => [route, role]));

    test.each(pairs)('GET %s returns 200 for a %s token', async (route, role) => {
        const response = await get(route, await tokenFor(role));

        expect(response.status).toBe(200);
        expect(response.body).toEqual(EXPECTED_BY_ROUTE[route]);
    });
});

describe('a token carrying a Role outside the declared set (Req 2.12)', () => {
    // Correctly signed, unexpired, and naming a User that exists, so `authenticate`
    // passes it through and the refusal is entirely the Role-enum check in
    // `authorize` -- which runs before the read exemption of Req 2.13.
    const unknownRoleToken = () =>
        jwt.sign({ sub: FIXTURE_USERS.Admin.id, role: 'Root' }, config.jwtSecret, {
            expiresIn: '8h',
        });

    test.each(ROUTES)('GET %s is answered 403 FORBIDDEN', async (route) => {
        const response = await get(route, unknownRoleToken());

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ code: 'FORBIDDEN', message: expect.any(String) });
    });
});

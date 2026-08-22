// backend/tests/authorization.test.js -- role-based authorization (Req 2.1 - 2.14).
//
// Every assertion is made over real HTTP, so `authenticate`, `authorize` and
// `errorHandler` all run inside the test (Req 12.13). The real app declares no write
// route until increment 5, so the role x route matrix runs against the stub write routes
// of tests/setup/authorizeTestApp.js, which mounts the real middleware and reproduces the
// exact `WRITE_ROUTE_PERMISSIONS` keys.
//
// Mandatory test 5 (a real restricted write route with a targeted document) is added to
// this file in task 5.12, once POST /api/inventory exists.

const jwt = require('jsonwebtoken');

const config = require('../src/config');
const User = require('../src/models/User');
const { ROLES, WRITE_ROUTE_PERMISSIONS } = require('../src/permissions');
const { app: realApp } = require('./setup/agent');
const {
    app: stubApp,
    callRoute,
    UNMAPPED_WRITE_ROUTE,
    READ_ROUTE,
    STUB_WRITE_MARKER,
} = require('./setup/authorizeTestApp');
const { FIXTURE_USERS, tokenFor } = require('./setup/seedFixture');

// The one response shape every denial must produce (Req 2.3, 2.5, 2.7, 2.11, 2.12).
const FORBIDDEN_BODY = { code: 'FORBIDDEN', message: expect.any(String) };

// Every (route, role) pair of the map, flagged with whether the map permits it.
const MATRIX = Object.entries(WRITE_ROUTE_PERMISSIONS).flatMap(([route, permitted]) =>
    ROLES.map((role) => [route, role, permitted.includes(role)])
);

const permittedPairs = MATRIX.filter(([, , permitted]) => permitted).map(([route, role]) => [route, role]);
const deniedPairs = MATRIX.filter(([, , permitted]) => !permitted).map(([route, role]) => [route, role]);

// Read every User as stored, so "modifies no document" is compared field by field.
const snapshotUsers = () => User.find({}).select('+passwordHash').sort({ email: 1 }).lean();

describe('the write route x role matrix (Req 2.2, 2.3, 2.4, 2.5, 2.6, 2.7)', () => {
    // Sanity guard: an empty matrix would make both blocks below vacuously green.
    test('covers every declared write route and every Role', () => {
        expect(MATRIX).toHaveLength(Object.keys(WRITE_ROUTE_PERMISSIONS).length * ROLES.length);
        expect(permittedPairs.length).toBeGreaterThan(0);
        expect(deniedPairs.length).toBeGreaterThan(0);
    });

    test.each(permittedPairs)('%s passes for a %s token', async (route, role) => {
        const response = await callRoute(route, await tokenFor(role));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ reached: true, role });
    });

    test.each(deniedPairs)('%s is denied for a %s token', async (route, role) => {
        const response = await callRoute(route, await tokenFor(role));

        expect(response.status).toBe(403);
        expect(response.body).toEqual(FORBIDDEN_BODY);
        // The route handler never ran.
        expect(response.body).not.toHaveProperty('reached');
    });
});

describe('a write route with no entry in the map (Req 2.11)', () => {
    test.each(ROLES)('is denied by default for a %s token', async (role) => {
        const response = await callRoute(UNMAPPED_WRITE_ROUTE, await tokenFor(role));

        expect(response.status).toBe(403);
        expect(response.body).toEqual(FORBIDDEN_BODY);
        expect(response.body).not.toHaveProperty('reached');
    });
});

describe('a token carrying a Role outside the declared set (Req 2.12)', () => {
    // Correctly signed and unexpired, and it names a User that exists -- the only thing
    // wrong with it is the role claim, so `authenticate` passes it through and the
    // decision is entirely the role-enum check in `authorize`.
    const unknownRoleToken = (role) =>
        jwt.sign({ sub: FIXTURE_USERS.Admin.id, role }, config.jwtSecret, { expiresIn: '8h' });

    // A token with no role claim at all is not one this server would issue, so
    // `authenticate` answers it 401 UNAUTHENTICATED before `authorize` ever sees it; that
    // case belongs to Req 1.7 and lives in tests/auth.test.js. Here every token carries a
    // role, just not a declared one -- including near misses in spelling and case.
    test.each([['Root'], ['admin'], ['OperationsUsers'], ['Admin ']])(
        'is denied on a write route when the role is %p',
        async (role) => {
            const response = await callRoute('POST /api/inventory', unknownRoleToken(role));

            expect(response.status).toBe(403);
            expect(response.body).toEqual(FORBIDDEN_BODY);
            expect(response.body).not.toHaveProperty('reached');
        }
    );

    test('is denied on a read route too, because the Role check comes first', async () => {
        const response = await callRoute(READ_ROUTE, unknownRoleToken('Root'));

        expect(response.status).toBe(403);
        expect(response.body).toEqual(FORBIDDEN_BODY);
    });
});

describe('read requests (Req 2.13)', () => {
    test.each(ROLES)('pass unchanged for a %s token', async (role) => {
        const response = await callRoute(READ_ROUTE, await tokenFor(role));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ reached: true, role });
    });
});

describe('the order of authentication and authorization (Req 2.1)', () => {
    test('a request with no token is answered 401 before any Role is evaluated', async () => {
        const response = await callRoute('POST /api/inventory');

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ code: 'UNAUTHENTICATED', message: expect.any(String) });
    });
});

describe('a denial modifies no document (Req 2.3, 2.5, 2.7, 2.11, 2.12)', () => {
    // The stub write handler stamps STUB_WRITE_MARKER on every User, so a reached handler
    // is visible in the database. This test proves it does -- without it, the assertions
    // below would hold even for a handler that writes nothing.
    test('the stub handler does write when the request is permitted', async () => {
        const response = await callRoute('POST /api/inventory', await tokenFor('Admin'));

        expect(response.status).toBe(200);
        const users = await snapshotUsers();
        expect(users.every((user) => String(user.assignedLocation) === STUB_WRITE_MARKER)).toBe(true);
    });

    test.each([
        ['a Role the route does not name', 'POST /api/inventory', () => tokenFor('SalesUser')],
        ['an unmapped write route', UNMAPPED_WRITE_ROUTE, () => tokenFor('Admin')],
        [
            'a Role outside the declared set',
            'POST /api/inventory',
            async () => jwt.sign({ sub: FIXTURE_USERS.Admin.id, role: 'Root' }, config.jwtSecret),
        ],
    ])('leaves every targeted document unchanged when denied for %s', async (_label, route, token) => {
        const before = await snapshotUsers();

        const response = await callRoute(route, await token());

        expect(response.status).toBe(403);
        expect(response.body).toEqual(FORBIDDEN_BODY);
        expect(response.body).not.toHaveProperty('reached');
        expect(await snapshotUsers()).toEqual(before);
    });
});

// ---------------------------------------------------------------------------------------
// Permission map completeness (Req 2.8, 2.14)
//
// The matrix above checks one direction: every entry in the map behaves as declared. This
// block checks the other: every write route the app actually DECLARES has an entry. That
// is what keeps criterion 2.14 true as increments 5 to 8 add routes -- a new write route
// with no entry fails here instead of silently relying on the deny-by-default branch.
// ---------------------------------------------------------------------------------------

// A method that can create, modify, or delete a document. GET routes are reads and pass
// for any valid Role (Req 2.13), so they need no entry.
const WRITE_METHODS = ['post', 'patch', 'put', 'delete'];

// POST /api/auth/login is deliberately outside the map: it is the one public route,
// mounted ahead of `authenticate`, so no Role exists to check (Req 1.8, 2.1).
const PUBLIC_WRITE_ROUTES = ['POST /api/auth/login'];

/** The literal mount path of a router layer, e.g. `/api` for `app.use('/api', router)`. */
function mountPath(layer) {
    if (layer.regexp.fast_slash) {
        return '';
    }

    const path = layer.regexp.source
        .replace(/^\^/, '')
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/');

    // A mount path carrying a parameter or any other pattern would leave regular
    // expression syntax behind and produce a wrong key. Fail loudly rather than report an
    // incomplete route list.
    if (/[$^?*+()[\]\\]/.test(path)) {
        throw new Error(
            `Cannot read the mount path of a router layer from ${layer.regexp}. ` +
            'tests/authorization.test.js expects every router to be mounted on a literal path.'
        );
    }
    return path;
}

/**
 * Walk a mounted Express router stack and return every declared write route as a
 * `"<METHOD> <mounted path>"` key -- the same shape `authorize` builds at run time.
 */
function declaredWriteRoutes(expressApp, stack = expressApp._router.stack, prefix = '') {
    return stack.flatMap((layer) => {
        if (layer.route) {
            return Object.keys(layer.route.methods)
                .filter((method) => WRITE_METHODS.includes(method))
                .map((method) => `${method.toUpperCase()} ${prefix}${layer.route.path}`);
        }
        if (layer.handle && layer.handle.stack) {
            return declaredWriteRoutes(expressApp, layer.handle.stack, prefix + mountPath(layer));
        }
        return [];
    });
}

describe('WRITE_ROUTE_PERMISSIONS completeness (Req 2.8, 2.14)', () => {
    test('every write route the app declares has exactly one entry', () => {
        const unmapped = declaredWriteRoutes(realApp).filter(
            (route) =>
                !PUBLIC_WRITE_ROUTES.includes(route) &&
                !Object.prototype.hasOwnProperty.call(WRITE_ROUTE_PERMISSIONS, route)
        );

        expect(unmapped).toEqual([]);
    });

    // Without this, the assertion above would also pass if the walk found nothing at all.
    test('the walk really does find the write routes the app declares', () => {
        expect(declaredWriteRoutes(realApp)).toEqual(expect.arrayContaining(PUBLIC_WRITE_ROUTES));
    });

    // And this proves it would catch a write route that has no entry: the stub app
    // declares exactly one such route on purpose.
    test('a write route with no entry is reported', () => {
        const unmapped = declaredWriteRoutes(stubApp).filter(
            (route) => !Object.prototype.hasOwnProperty.call(WRITE_ROUTE_PERMISSIONS, route)
        );

        expect(unmapped).toEqual([UNMAPPED_WRITE_ROUTE]);
    });

    test('every entry names at least one declared Role', () => {
        for (const [route, permitted] of Object.entries(WRITE_ROUTE_PERMISSIONS)) {
            expect(Array.isArray(permitted)).toBe(true);
            expect(permitted.length).toBeGreaterThan(0);
            expect(permitted).toEqual([...new Set(permitted)]);
            permitted.forEach((role) => expect(ROLES).toContain(role));
            expect(route).toMatch(/^(POST|PATCH|PUT|DELETE) \/api\//);
        }
    });

    // Named explicitly because Req 2.14 calls out this one route: it must not rely on the
    // deny-by-default branch at run time.
    test('the work order status change route is named in the map', () => {
        expect(WRITE_ROUTE_PERMISSIONS['PATCH /api/work-orders/:id/status']).toEqual([
            'Admin',
            'OperationsUser',
        ]);
    });
});

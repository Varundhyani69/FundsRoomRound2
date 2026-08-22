// backend/tests/setup/seedFixture.js -- the fixed per-test seed fixture (Req 12.11).
//
// dbSetup.js deletes every document of every collection before each test and then calls
// `seedFixture()`, so every test starts from this same known state and the suite passes
// in any execution order. Task 5.9 extends this module further with the inventory records.
//
// Only the API_Server's own modules are used to build the state: the models and
// `hashPassword` from the Auth_Service, so the fixture cannot drift from how a real
// document is stored.

const crypto = require('crypto');

const Category = require('../../src/models/Category');
const Item = require('../../src/models/Item');
const Location = require('../../src/models/Location');
const User = require('../../src/models/User');
const { hashPassword, login } = require('../../src/services/auth.service');

// Fixed identifiers: a test can assert against a known id, and an issued token keeps
// naming the same User for the whole run.
const USER_IDS = {
    Admin: '000000000000000000000a01',
    OperationsUser: '000000000000000000000a02',
    SalesUser: '000000000000000000000a03',
};

// The reference data ids are fixed for the same reason the User ids are: a test can name
// a Location or an Item directly instead of looking one up first. Each block of ids uses
// its own trailing letter, so an id in a failure message says which collection it is from.
const LOCATION_IDS = {
    main: '000000000000000000000b01',
    secondary: '000000000000000000000b02',
};

const CATEGORY_IDS = {
    rawMaterial: '000000000000000000000c01',
};

const ITEM_IDS = {
    widget: '000000000000000000000d01',
    gadget: '000000000000000000000d02',
};

// Two Locations, so a transfer in a test has a distinct source and destination.
const FIXTURE_LOCATIONS = {
    main: {
        id: LOCATION_IDS.main,
        code: 'MAIN',
        name: 'Main Warehouse',
    },
    secondary: {
        id: LOCATION_IDS.secondary,
        code: 'SEC',
        name: 'Secondary Warehouse',
    },
};

// One Category, which both fixture Items belong to.
const FIXTURE_CATEGORIES = {
    rawMaterial: {
        id: CATEGORY_IDS.rawMaterial,
        name: 'Raw Material',
    },
};

// Two Items, so a test that needs "another Item" does not have to create one.
const FIXTURE_ITEMS = {
    widget: {
        id: ITEM_IDS.widget,
        code: 'WIDGET',
        name: 'Fixture Widget',
        category: CATEGORY_IDS.rawMaterial,
    },
    gadget: {
        id: ITEM_IDS.gadget,
        code: 'GADGET',
        name: 'Fixture Gadget',
        category: CATEGORY_IDS.rawMaterial,
    },
};

// Test-only passwords. They are generated fresh in this process and never written to
// disk, so no tracked file carries a User password (Req 14.5). Tests read them back from
// the exported fixture instead of repeating a literal.
const testPassword = (label) =>
    `test-fixture-${label}-${crypto.randomBytes(9).toString('hex')}`;

// One User per Role, each with a password the tests know, so any test can log in as any
// Role over HTTP.
const FIXTURE_USERS = {
    Admin: {
        id: USER_IDS.Admin,
        email: 'admin@fixture.test',
        role: 'Admin',
        password: testPassword('admin'),
    },
    OperationsUser: {
        id: USER_IDS.OperationsUser,
        email: 'operations@fixture.test',
        role: 'OperationsUser',
        password: testPassword('operations'),
        // The one seeded User tied to a site, so a test can check what an assigned
        // Assigned_Location looks like without writing one first (Req 15.4).
        assignedLocation: LOCATION_IDS.main,
    },
    SalesUser: {
        id: USER_IDS.SalesUser,
        email: 'sales@fixture.test',
        role: 'SalesUser',
        password: testPassword('sales'),
    },
};

// bcrypt at cost factor 10 is deliberately slow, and the three passwords do not change
// within a run, so each hash is computed once per worker and reused by every test.
const hashCache = new Map();

async function hashFor(role) {
    if (!hashCache.has(role)) {
        hashCache.set(role, await hashPassword(FIXTURE_USERS[role].password));
    }
    return hashCache.get(role);
}

/**
 * Insert one User per Role into the empty database.
 *
 * @returns {Promise<typeof FIXTURE_USERS>} the fixture description, ids included
 */
async function seedUsers() {
    // Guard, not decoration: if the Role enum ever grows, the fixture stops silently
    // covering only some of the Roles and this fails loudly instead.
    const schemaRoles = User.schema.path('role').enumValues;
    const missing = schemaRoles.filter((role) => !FIXTURE_USERS[role]);
    if (missing.length > 0) {
        throw new Error(
            `tests/setup/seedFixture.js has no User for role(s): ${missing.join(', ')}. ` +
            'The fixture must hold exactly one User per Role (Req 12.11).'
        );
    }

    await User.create(
        await Promise.all(
            schemaRoles.map(async (role) => ({
                _id: FIXTURE_USERS[role].id,
                email: FIXTURE_USERS[role].email,
                passwordHash: await hashFor(role),
                role,
                // Only the Operations_User names one; the others stay unassigned.
                assignedLocation: FIXTURE_USERS[role].assignedLocation ?? null,
            }))
        )
    );

    return FIXTURE_USERS;
}

/**
 * Insert the reference data every other fixture row points at: the Locations, the
 * Category, and the Items belonging to it.
 *
 * @returns {Promise<{
 *   locations: typeof FIXTURE_LOCATIONS,
 *   categories: typeof FIXTURE_CATEGORIES,
 *   items: typeof FIXTURE_ITEMS,
 * }>} the fixture description, ids included
 */
async function seedReferenceData() {
    // Locations and Categories reference nothing, so they can be written together. The
    // Items follow, because each one names an existing Category (Req 3.2).
    await Promise.all([
        Location.create(
            Object.values(FIXTURE_LOCATIONS).map(({ id, code, name }) => ({
                _id: id,
                code,
                name,
            }))
        ),
        Category.create(
            Object.values(FIXTURE_CATEGORIES).map(({ id, name }) => ({
                _id: id,
                name,
            }))
        ),
    ]);

    await Item.create(
        Object.values(FIXTURE_ITEMS).map(({ id, code, name, category }) => ({
            _id: id,
            code,
            name,
            category,
        }))
    );

    return {
        locations: FIXTURE_LOCATIONS,
        categories: FIXTURE_CATEGORIES,
        items: FIXTURE_ITEMS,
    };
}

/**
 * Load the whole fixture. Called from the `beforeEach` in dbSetup.js.
 *
 * @returns {Promise<{
 *   users: typeof FIXTURE_USERS,
 *   locations: typeof FIXTURE_LOCATIONS,
 *   categories: typeof FIXTURE_CATEGORIES,
 *   items: typeof FIXTURE_ITEMS,
 * }>}
 */
async function seedFixture() {
    // Reference data first: the seeded Operations_User names a fixture Location, so that
    // Location has to exist by the time the Users are written.
    const reference = await seedReferenceData();
    const users = await seedUsers();

    return { users, ...reference };
}

/**
 * A valid access token for the seeded User of a Role, obtained through the real login
 * path, so a token used by a test is exactly a token the API_Server issues.
 *
 * @param {'Admin'|'OperationsUser'|'SalesUser'} role
 * @returns {Promise<string>} the signed JSON Web Token
 */
async function tokenFor(role) {
    const user = FIXTURE_USERS[role];
    if (!user) {
        throw new Error(
            `tokenFor: unknown role "${role}". Known roles: ${Object.keys(FIXTURE_USERS).join(', ')}.`
        );
    }

    const { token } = await login(user.email, user.password);
    return token;
}

module.exports = {
    FIXTURE_USERS,
    FIXTURE_LOCATIONS,
    FIXTURE_CATEGORIES,
    FIXTURE_ITEMS,
    seedUsers,
    seedReferenceData,
    seedFixture,
    tokenFor,
};

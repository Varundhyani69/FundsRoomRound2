// backend/tests/setup/seedFixture.js -- the fixed per-test seed fixture (Req 12.11).
//
// dbSetup.js deletes every document of every collection before each test and then calls
// `seedFixture()`, so every test starts from this same known state and the suite passes
// in any execution order. Tasks 4.4 and 5.9 extend this module with the reference data
// and the inventory records.
//
// Only the API_Server's own modules are used to build the state: the User model and
// `hashPassword` from the Auth_Service, so the fixture cannot drift from how a real User
// is stored.

const crypto = require('crypto');

const User = require('../../src/models/User');
const { hashPassword, login } = require('../../src/services/auth.service');

// Fixed identifiers: a test can assert against a known id, and an issued token keeps
// naming the same User for the whole run.
const USER_IDS = {
    Admin: '000000000000000000000a01',
    OperationsUser: '000000000000000000000a02',
    SalesUser: '000000000000000000000a03',
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
            }))
        )
    );

    return FIXTURE_USERS;
}

/**
 * Load the whole fixture. Called from the `beforeEach` in dbSetup.js.
 *
 * @returns {Promise<{ users: typeof FIXTURE_USERS }>}
 */
async function seedFixture() {
    const users = await seedUsers();
    return { users };
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
    seedUsers,
    seedFixture,
    tokenFor,
};

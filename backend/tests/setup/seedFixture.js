// backend/tests/setup/seedFixture.js -- the fixed per-test seed fixture (Req 12.11).
//
// dbSetup.js deletes every document of every collection before each test and then calls
// `seedFixture()`, so every test starts from this same known state and the suite passes
// in any execution order.
//
// Only the API_Server's own modules are used to build the state: the shared pool, `ROLES` from
// the permission map, `hashPassword` from the Auth_Service, and `openingMovementReference` from
// the movement reference builders, so the fixture cannot drift from how a real row is stored.
//
// The fixed ids below are 24-character hex strings, which is exactly the CHAR(24) primary key
// shape src/db/id.js generates -- so they survived the migration from MongoDB unchanged, and
// every test that names one still names the same row.

const crypto = require('crypto');

const { query } = require('../../src/db/pool');
const { newId } = require('../../src/db/id');
const { ROLES } = require('../../src/permissions');
const { hashPassword, login } = require('../../src/services/auth.service');
const { openingMovementReference } = require('../../src/services/movementReference');

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

// Inventory_Record ids use their own trailing letter, the same reason every other reference
// id block does: a failure message naming an `...e01` id says at a glance which collection
// it is from.
const INVENTORY_RECORD_IDS = {
    widgetMainBatchA: '000000000000000000000e01',
    widgetMainBatchB: '000000000000000000000e02',
    gadgetSecondaryLow: '000000000000000000000e03',
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

// Three Inventory_Records, covering the two shapes a test needs beyond the "at least two"
// floor of Req 12.11:
//   - `widgetMainBatchA` and `widgetMainBatchB` are the same Item at the same Location in
//     two Batches, so a reservation-across-batches test has more than one batch to allocate
//     against (available 70 + 50 = 120 at `main` for `widget`, consumed in ascending batch
//     order starting with "A").
//   - `gadgetSecondaryLow` is fully reserved (available 0), so a shortage or
//     insufficient-availability test has a combination to hit without writing one first.
const FIXTURE_INVENTORY_RECORDS = {
    widgetMainBatchA: {
        id: INVENTORY_RECORD_IDS.widgetMainBatchA,
        item: ITEM_IDS.widget,
        location: LOCATION_IDS.main,
        batch: 'A',
        physicalQuantity: 100,
        reservedQuantity: 30,
    },
    widgetMainBatchB: {
        id: INVENTORY_RECORD_IDS.widgetMainBatchB,
        item: ITEM_IDS.widget,
        location: LOCATION_IDS.main,
        batch: 'B',
        physicalQuantity: 50,
        reservedQuantity: 0,
    },
    gadgetSecondaryLow: {
        id: INVENTORY_RECORD_IDS.gadgetSecondaryLow,
        item: ITEM_IDS.gadget,
        location: LOCATION_IDS.secondary,
        batch: 'A',
        physicalQuantity: 5,
        reservedQuantity: 5,
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
    // Guard, not decoration: if the Role set ever grows, the fixture stops silently covering
    // only some of the Roles and this fails loudly instead. ROLES is read from
    // src/permissions.js -- the same list the schema's ENUM and the authorize middleware use.
    const missing = ROLES.filter((role) => !FIXTURE_USERS[role]);
    if (missing.length > 0) {
        throw new Error(
            `tests/setup/seedFixture.js has no User for role(s): ${missing.join(', ')}. ` +
            'The fixture must hold exactly one User per Role (Req 12.11).'
        );
    }

    const rows = await Promise.all(
        ROLES.map(async (role) => [
            FIXTURE_USERS[role].id,
            FIXTURE_USERS[role].email,
            await hashFor(role),
            role,
            // Only the Operations_User names one; the others stay unassigned (Req 15.4).
            FIXTURE_USERS[role].assignedLocation ?? null,
        ])
    );

    // One multi-row INSERT rather than one per user: fewer round trips, and it runs before
    // every single test in the suite.
    await query(
        `INSERT INTO users (id, email, password_hash, role, assigned_location_id)
         VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
        rows.flat()
    );

    return FIXTURE_USERS;
}

/**
 * Insert the reference data every other fixture row points at: the Locations, the Category,
 * and the Items belonging to it.
 *
 * @returns {Promise<{ locations: object, categories: object, items: object }>}
 */
async function seedReferenceData() {
    const locations = Object.values(FIXTURE_LOCATIONS);
    const categories = Object.values(FIXTURE_CATEGORIES);
    const items = Object.values(FIXTURE_ITEMS);

    // Locations and Categories reference nothing, so they go in together. The Items follow,
    // because each one names an existing Category and the foreign key is checked immediately
    // (Req 3.2) -- unlike the old MongoDB fixture, where insert order was merely convention.
    await Promise.all([
        query(
            `INSERT INTO locations (id, code, name)
             VALUES ${locations.map(() => '(?, ?, ?)').join(', ')}`,
            locations.flatMap(({ id, code, name }) => [id, code, name])
        ),
        query(
            `INSERT INTO categories (id, name)
             VALUES ${categories.map(() => '(?, ?)').join(', ')}`,
            categories.flatMap(({ id, name }) => [id, name])
        ),
    ]);

    await query(
        `INSERT INTO items (id, code, name, category_id)
         VALUES ${items.map(() => '(?, ?, ?, ?)').join(', ')}`,
        items.flatMap(({ id, code, name, category }) => [id, code, name, category])
    );

    return {
        locations: FIXTURE_LOCATIONS,
        categories: FIXTURE_CATEGORIES,
        items: FIXTURE_ITEMS,
    };
}

/**
 * Insert the three Inventory_Records of `FIXTURE_INVENTORY_RECORDS`, plus the ledger rows
 * that back them.
 *
 * Every record is written together with its inventory_transactions rows rather than alone, so
 * the fixture itself already satisfies the ledger reconstruction property (Req 4.7) instead of
 * only becoming provable once a test moves a record. Each record gets its opening row
 * (physical_delta = physical_quantity, Req 4.9), and the one record seeded with a starting
 * reserved quantity gets a second row moving that quantity into reserved_quantity.
 *
 * @returns {Promise<typeof FIXTURE_INVENTORY_RECORDS>}
 */
async function seedInventoryRecords() {
    const records = Object.values(FIXTURE_INVENTORY_RECORDS);

    await query(
        `INSERT INTO inventory_records
             (id, item_id, location_id, batch, physical_quantity, reserved_quantity)
         VALUES ${records.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        records.flatMap(({ id, item, location, batch, physicalQuantity, reservedQuantity }) => [
            id,
            item,
            location,
            batch,
            physicalQuantity,
            reservedQuantity,
        ])
    );

    const transactions = [];

    for (const record of records) {
        transactions.push([
            newId(),
            record.id,
            record.physicalQuantity,
            0,
            openingMovementReference(record.id),
        ]);

        if (record.reservedQuantity > 0) {
            // Not `reserveMovementReference`: that builder names a Customer_Order id, and no
            // order exists behind this starting reservation. A fixture-only reference is
            // enough, since uniqueness only has to hold against the other rows this module
            // writes.
            transactions.push([
                newId(),
                record.id,
                0,
                record.reservedQuantity,
                `FIXTURE:${record.id}:RESERVE`,
            ]);
        }
    }

    await query(
        `INSERT INTO inventory_transactions
             (id, inventory_record_id, physical_delta, reserved_delta, movement_reference)
         VALUES ${transactions.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
        transactions.flat()
    );

    return FIXTURE_INVENTORY_RECORDS;
}

/**
 * Load the whole fixture. Called from the `beforeEach` in dbSetup.js.
 *
 * @returns {Promise<object>} every fixture description, ids included
 */
async function seedFixture() {
    // Reference data first: the seeded Operations_User names a fixture Location, and the
    // Inventory_Records name fixture Items and Locations. Under MongoDB this ordering was a
    // convention; here the foreign keys enforce it, so getting it wrong fails immediately
    // rather than leaving a dangling reference.
    const reference = await seedReferenceData();
    const users = await seedUsers();
    const inventoryRecords = await seedInventoryRecords();

    return { users, inventoryRecords, ...reference };
}

/**
 * A valid access token for the seeded User of a Role, obtained through the real login path, so
 * a token used by a test is exactly a token the API_Server issues.
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
    FIXTURE_INVENTORY_RECORDS,
    seedUsers,
    seedReferenceData,
    seedInventoryRecords,
    seedFixture,
    tokenFor,
};

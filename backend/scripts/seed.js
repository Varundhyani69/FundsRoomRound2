// backend/scripts/seed.js -- the one non-interactive seed command (Req 13.5).
//
// Run it with `npm run seed` from `backend/`, after `npm run migrate` has created the schema.
// It prompts for nothing, reads every value it needs from the environment, and exits non-zero
// on any failure so a broken seed run is visible to a script that calls it.
//
// Passwords are never stored in this file or any other tracked file: each seeded user takes
// its password from an environment variable (Req 13.8, 14.5), and the value is only ever
// passed to `hashPassword` from the Auth_Service, so the database holds a bcrypt hash and
// nothing else (Req 1.5).
//
// Idempotent: every reference row is upserted on its unique business key (user email,
// location code, category name, item code), so running the seed twice leaves the same rows
// rather than duplicating them or failing on the unique indexes. Inventory records are
// idempotent by a find-before-create check on their own unique key, because creating one also
// writes an opening ledger row and an upsert would either skip that row on a second run or
// write a second one. Work orders are idempotent the same way: `work_orders` carries no
// unique index (a site can legitimately have many work orders for the same item), so the
// check below matches on the four fields the seed data declares, which is specific enough to
// find the row a previous run created. Nothing is deleted, so a database already carrying
// other data keeps it. Re-running does reset each seeded user's password to the value
// currently in the environment.

const config = require('../src/config'); // loads .env and validates MYSQL_* first
const { connect, disconnect } = require('../src/db/connect');
const { query } = require('../src/db/pool');
const { newId } = require('../src/db/id');
const { hashPassword } = require('../src/services/auth.service');
const { createInventoryRecord } = require('../src/services/inventory.service');
const { createWorkOrder } = require('../src/services/workOrder.service');

// bcrypt only consumes the first 72 bytes of a password, and the login schema rejects
// anything longer, so a longer seed password would silently not be the password that works.
const MAX_PASSWORD_LENGTH = 72;

// The seed dataset. Declared as plain data and resolved by business key, so adding a row is a
// one-line edit here rather than a change to the steps below.
const SEED_LOCATIONS = [
    { code: 'WH-MAIN', name: 'Main Warehouse' },
    { code: 'WH-NORTH', name: 'North Depot' },
];

const SEED_CATEGORIES = [{ name: 'Raw Material' }];

const SEED_ITEMS = [
    { code: 'ITM-1001', name: 'Steel Bolt M8', categoryName: 'Raw Material' },
    { code: 'ITM-1002', name: 'Steel Nut M8', categoryName: 'Raw Material' },
];

// Opening stock, keyed by the same business keys as the reference data above (Req 13.5).
// ITM-1001 at WH-MAIN carries 50 units: enough for a later Internal_Transfer to WH-NORTH and
// enough headroom that the seeded Work_Order below can require more than 50 and show a
// non-zero shortage. WH-NORTH starts with no record for this item on purpose, so a transfer's
// receipt is what creates one -- exactly the case Req 6.8 covers.
const SEED_INVENTORY_RECORDS = [
    { itemCode: 'ITM-1001', locationCode: 'WH-MAIN', batch: 'BATCH-001', physicalQuantity: 50 },
];

// A Work_Order whose requiredQuantity (80) exceeds ITM-1001's availability at WH-MAIN (50,
// with nothing reserved), so a reviewer reading it back sees a non-zero Shortage_Quantity of
// 30 without creating anything by hand (Req 13.5). Assigned to the seeded OperationsUser, who
// is already tied to WH-MAIN.
const SEED_WORK_ORDERS = [
    {
        itemCode: 'ITM-1001',
        locationCode: 'WH-MAIN',
        requiredQuantity: 80,
        assignedUserRole: 'OperationsUser',
    },
];

// One user per role. `passwordVar` names the environment variable the password comes from;
// the README repeats this table so a reviewer can log in without reading this file (Req 13.8).
const SEED_USERS = [
    {
        email: 'admin@mini-erp.local',
        role: 'Admin',
        passwordVar: 'SEED_ADMIN_PASSWORD',
        // An Admin is not tied to a site.
        locationCode: null,
    },
    {
        email: 'operations@mini-erp.local',
        role: 'OperationsUser',
        passwordVar: 'SEED_OPS_PASSWORD',
        locationCode: 'WH-MAIN',
    },
    {
        email: 'sales@mini-erp.local',
        role: 'SalesUser',
        passwordVar: 'SEED_SALES_PASSWORD',
        locationCode: null,
    },
];

/**
 * Read and check the three seed password variables.
 *
 * All three are reported in one message, so a reviewer fixes their environment once instead of
 * rerunning the command three times. This is the seed script's own check: the API server's
 * required set stays exactly what the config loader declares.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ok: true, passwords: Record<string, string>} | {ok: false, errors: string[]}}
 */
function readSeedPasswords(env) {
    const errors = [];
    const passwords = {};

    for (const { passwordVar } of SEED_USERS) {
        const value = env[passwordVar];

        if (typeof value !== 'string' || value.trim() === '') {
            errors.push(`${passwordVar} is required and must not be blank`);
            continue;
        }
        if (value.length > MAX_PASSWORD_LENGTH) {
            errors.push(`${passwordVar} must be at most ${MAX_PASSWORD_LENGTH} characters`);
            continue;
        }

        passwords[passwordVar] = value;
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true, passwords };
}

/**
 * Upserts one row on its unique business key and returns its id.
 *
 * `INSERT ... ON DUPLICATE KEY UPDATE` is MySQL's atomic upsert: if the unique key already
 * exists the row is updated instead of failing. The `id` is only used on the insert path --
 * an existing row keeps the id it already had, which is why the id is read back rather than
 * assumed.
 *
 * @param {string} table
 * @param {Record<string, any>} keyColumns the unique business key
 * @param {Record<string, any>} valueColumns columns to set on both insert and update
 * @returns {Promise<string>} the row's id
 */
async function upsert(table, keyColumns, valueColumns) {
    const insertColumns = { id: newId(), ...keyColumns, ...valueColumns };
    const columnNames = Object.keys(insertColumns);
    const updateAssignments = Object.keys(valueColumns).map((name) => `${name} = VALUES(${name})`);

    await query(
        `INSERT INTO ${table} (${columnNames.join(', ')})
         VALUES (${columnNames.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${updateAssignments.join(', ')}`,
        Object.values(insertColumns)
    );

    const whereClause = Object.keys(keyColumns).map((name) => `${name} = ?`).join(' AND ');
    const rows = await query(
        `SELECT id FROM ${table} WHERE ${whereClause}`,
        Object.values(keyColumns)
    );
    return rows[0].id;
}

/** Two locations, so an Internal_Transfer has a source and a destination (Req 13.5). */
async function seedLocations() {
    const locations = new Map();
    for (const { code, name } of SEED_LOCATIONS) {
        locations.set(code, await upsert('locations', { code }, { name }));
    }
    return locations;
}

/** At least one category, because every item references one (Req 13.5). */
async function seedCategories() {
    const categories = new Map();
    for (const { name } of SEED_CATEGORIES) {
        // `name` is both the unique key and the only column, so it is matched on and set.
        categories.set(name, await upsert('categories', { name }, { name }));
    }
    return categories;
}

/** Two items, each referencing a seeded category by id (Req 13.5, 3.2). */
async function seedItems(categories) {
    const items = new Map();
    for (const { code, name, categoryName } of SEED_ITEMS) {
        const categoryId = categories.get(categoryName);
        if (!categoryId) {
            throw new Error(
                `Seed item ${code} names category "${categoryName}", which is not in SEED_CATEGORIES.`
            );
        }
        items.set(code, await upsert('items', { code }, { name, category_id: categoryId }));
    }
    return items;
}

/** One user per role, each password hashed by the Auth_Service (Req 13.5, 13.8, 1.5). */
async function seedUsers(passwords, locations) {
    const users = new Map();

    for (const { email, role, passwordVar, locationCode } of SEED_USERS) {
        const locationId = locationCode ? locations.get(locationCode) : null;
        if (locationCode && !locationId) {
            throw new Error(
                `Seed user ${email} names location "${locationCode}", which is not in SEED_LOCATIONS.`
            );
        }

        users.set(
            role,
            await upsert(
                'users',
                { email },
                {
                    // Hashed here and never logged, so no plaintext value reaches the
                    // database or the console.
                    password_hash: await hashPassword(passwords[passwordVar]),
                    role,
                    assigned_location_id: locationId,
                }
            )
        );
    }

    return users;
}

/**
 * At least one inventory record with availability >= 1 at a location usable as a transfer
 * source (Req 13.5).
 *
 * `createInventoryRecord` from the Inventory_Service is reused rather than a direct INSERT,
 * because that function is the one place that also writes the opening ledger row in the same
 * transaction (Req 4.4, 4.9) -- inserting the row without it would leave physical_quantity
 * unreconstructable from the ledger (Req 4.7). Idempotency is a find-before-create check on
 * the same unique key the schema enforces, since `createInventoryRecord` deliberately rejects
 * an existing triple with DUPLICATE_INVENTORY_RECORD rather than upserting it.
 */
async function seedInventoryRecords(items, locations) {
    const records = new Map();

    for (const { itemCode, locationCode, batch, physicalQuantity } of SEED_INVENTORY_RECORDS) {
        const itemId = items.get(itemCode);
        const locationId = locations.get(locationCode);
        if (!itemId || !locationId) {
            throw new Error(
                `Seed inventory record names item "${itemCode}" or location "${locationCode}", ` +
                'which is not in SEED_ITEMS / SEED_LOCATIONS.'
            );
        }

        const existing = await query(
            'SELECT id FROM inventory_records WHERE item_id = ? AND location_id = ? AND batch = ?',
            [itemId, locationId, batch]
        );

        const id =
            existing.length > 0
                ? existing[0].id
                : String(
                    (
                        await createInventoryRecord({
                            item: itemId,
                            location: locationId,
                            batch,
                            physicalQuantity,
                        })
                    )._id
                );

        records.set(`${itemCode}:${locationCode}:${batch}`, id);
    }

    return records;
}

/**
 * At least one work order whose requiredQuantity exceeds the availability of its item at its
 * location, so a non-zero shortage is observable as soon as the seed finishes (Req 13.5).
 *
 * `createWorkOrder` from the Work_Order_Service is reused rather than a direct INSERT, so the
 * seeded row goes through the same existence checks and default status every API-created work
 * order does.
 */
async function seedWorkOrders(items, locations, users) {
    const workOrders = new Map();
    const adminId = users.get('Admin');

    for (const { itemCode, locationCode, requiredQuantity, assignedUserRole } of SEED_WORK_ORDERS) {
        const itemId = items.get(itemCode);
        const locationId = locations.get(locationCode);
        const assignedUserId = users.get(assignedUserRole);
        if (!itemId || !locationId || !assignedUserId) {
            throw new Error(
                `Seed work order names item "${itemCode}", location "${locationCode}", or ` +
                `assigned user role "${assignedUserRole}", which is not among the seeded ` +
                'items, locations, or users.'
            );
        }

        const existing = await query(
            `SELECT id FROM work_orders
              WHERE item_id = ? AND location_id = ? AND assigned_user_id = ? AND required_quantity = ?`,
            [itemId, locationId, assignedUserId, requiredQuantity]
        );

        const id =
            existing.length > 0
                ? existing[0].id
                : String(
                    (
                        await createWorkOrder({
                            location: locationId,
                            item: itemId,
                            requiredQuantity,
                            assignedUser: assignedUserId,
                            createdBy: adminId,
                        })
                    )._id
                );

        workOrders.set(`${itemCode}:${locationCode}:${requiredQuantity}`, id);
    }

    return workOrders;
}

/**
 * Load the whole seed dataset.
 *
 * The steps run in dependency order and each returns its ids keyed by business key, so a
 * later step looks an id up without querying again.
 *
 * @param {Record<string, string>} passwords validated seed passwords, keyed by variable name
 */
async function seed(passwords) {
    const locations = await seedLocations();
    const categories = await seedCategories();
    const items = await seedItems(categories);
    const users = await seedUsers(passwords, locations);
    const inventoryRecords = await seedInventoryRecords(items, locations);
    const workOrders = await seedWorkOrders(items, locations, users);

    return { locations, categories, items, users, inventoryRecords, workOrders };
}

/** One line per seeded user: email, role, and the variable its password came from. */
function reportUsers(users) {
    console.log('Seeded users (passwords come from the environment, never from a file):');
    for (const { email, role, passwordVar } of SEED_USERS) {
        console.log(`  ${role.padEnd(15)} ${email.padEnd(28)} password from ${passwordVar}`);
    }
    console.log(`  ${users.size} user row(s) present.`);
}

async function main() {
    // Checked before the connection is opened, so a missing password costs nothing.
    const passwordCheck = readSeedPasswords(process.env);
    if (!passwordCheck.ok) {
        console.error(
            'Cannot seed. Set the seeded user passwords in backend/.env ' +
            '(see backend/.env.example):\n' +
            passwordCheck.errors.map((error) => `  - ${error}`).join('\n')
        );
        return 1;
    }

    await connect(config.mysql);

    try {
        const { locations, categories, items, users, inventoryRecords, workOrders } = await seed(
            passwordCheck.passwords
        );
        reportUsers(users);
        console.log(
            `Seeded reference data: ${locations.size} location(s), ` +
            `${categories.size} category/categories, ${items.size} item(s), ` +
            `${inventoryRecords.size} inventory record(s), ` +
            `${workOrders.size} work order(s).`
        );
        return 0;
    } finally {
        await disconnect();
    }
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error) => {
        // One message, no stack trace of the caller's making: enough to act on, and no secret
        // value, because passwords are never carried on an error.
        console.error(`Seed failed: ${error.message}`);
        process.exitCode = 1;
    });

module.exports = { readSeedPasswords, SEED_USERS };

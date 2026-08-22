// backend/scripts/seed.js -- the one non-interactive seed command (Req 13.5).
//
// Run it with `npm run seed` from `backend/`. It prompts for nothing, reads every value it
// needs from the environment, and exits non-zero on any failure so a broken seed run is
// visible to a script that calls it.
//
// Passwords are never stored in this file or in any other tracked file: each seeded User
// takes its password from an environment variable (Req 13.8, 14.5), and the value is only
// ever passed to `hashPassword` from the Auth_Service, so the database holds a bcrypt hash
// and nothing else (Req 1.5).
//
// Idempotent: every reference document is upserted on its unique business key (User email,
// Location code, Category name, Item code), so running the seed twice leaves the same rows
// rather than duplicating them or erroring on the unique indexes. Inventory_Records are
// idempotent the same way but by a find-before-create check on their own unique key ({ item,
// location, batch }), since creating one always writes an opening ledger row and an upsert
// would either skip that row on a second run or write a second one. Nothing is deleted, so a
// database that already carries other data keeps it. Re-running does reset the password of
// each seeded User to the value currently in the environment.

const config = require('../src/config'); // loads .env and validates MONGODB_URI first
const { connect, disconnect } = require('../src/db/connect');
const { hashPassword } = require('../src/services/auth.service');
const { createInventoryRecord } = require('../src/services/inventory.service');

const User = require('../src/models/User');
const Category = require('../src/models/Category');
const Item = require('../src/models/Item');
const Location = require('../src/models/Location');
const InventoryRecord = require('../src/models/InventoryRecord');

// bcrypt only consumes the first 72 bytes of a password, and the login schema rejects
// anything longer, so a longer seed password would silently not be the password that works.
const MAX_PASSWORD_LENGTH = 72;

// The seed dataset. Reference data is declared as plain data and resolved by business key,
// so adding a row is a one-line edit here rather than a change to the steps below.
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
// ITM-1001 at WH-MAIN carries 50 units: enough for a later Internal_Transfer to WH-NORTH
// (a transfer of, say, 20 units leaves plenty behind) and enough headroom that task 6.5's
// seeded Work_Order can name a requiredQuantity above 50 and show a non-zero
// Shortage_Quantity. WH-NORTH itself starts with no Inventory_Record for this item, so a
// transfer's receipt step is what creates one, which is exactly the case Req 6.8 covers.
const SEED_INVENTORY_RECORDS = [
    { itemCode: 'ITM-1001', locationCode: 'WH-MAIN', batch: 'BATCH-001', physicalQuantity: 50 },
];

// One User per Role. `passwordVar` names the environment variable the password comes from;
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
 * All three are reported in one message, so a reviewer fixes their environment once
 * instead of rerunning the command three times. This is the seed script's own check: the
 * API server's required set stays at exactly the four variables of the config loader.
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

/** Upsert one document on its unique key and return the stored document. */
function upsertBy(Model, key, fields) {
    return Model.findOneAndUpdate(
        key,
        { $set: fields },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
}

/** Two Locations, so an Internal_Transfer has a source and a destination (Req 13.5). */
async function seedLocations() {
    const locations = new Map();

    for (const { code, name } of SEED_LOCATIONS) {
        const location = await upsertBy(Location, { code }, { name });
        locations.set(code, location);
    }

    return locations;
}

/** At least one Category, because every Item references one (Req 13.5). */
async function seedCategories() {
    const categories = new Map();

    for (const { name } of SEED_CATEGORIES) {
        // `name` is both the unique key and the only field, so it is set as well as matched;
        // an update document with an empty `$set` is not a valid MongoDB update.
        const category = await upsertBy(Category, { name }, { name });
        categories.set(name, category);
    }

    return categories;
}

/** Two Items, each pointing at a seeded Category by ObjectId reference (Req 13.5, 3.2). */
async function seedItems(categories) {
    const items = new Map();

    for (const { code, name, categoryName } of SEED_ITEMS) {
        const category = categories.get(categoryName);
        if (!category) {
            throw new Error(
                `Seed item ${code} names category "${categoryName}", which is not in SEED_CATEGORIES.`
            );
        }

        const item = await upsertBy(Item, { code }, { name, category: category._id });
        items.set(code, item);
    }

    return items;
}

/** One User per Role, each password hashed by the Auth_Service (Req 13.5, 13.8, 1.5). */
async function seedUsers(passwords, locations) {
    const users = new Map();

    for (const { email, role, passwordVar, locationCode } of SEED_USERS) {
        const location = locationCode ? locations.get(locationCode) : null;
        if (locationCode && !location) {
            throw new Error(
                `Seed user ${email} names location "${locationCode}", which is not in SEED_LOCATIONS.`
            );
        }

        const user = await upsertBy(
            User,
            { email },
            {
                // Hashed here and never logged, so no plaintext value reaches the database
                // or the console.
                passwordHash: await hashPassword(passwords[passwordVar]),
                role,
                assignedLocation: location ? location._id : null,
            }
        );

        users.set(role, user);
    }

    return users;
}

/**
 * At least one Inventory_Record with Available_Quantity >= 1 at a Location usable as an
 * Internal_Transfer source (Req 13.5).
 *
 * `createInventoryRecord` from the Inventory_Service is reused rather than an `upsertBy` on
 * the InventoryRecord model directly, because that service function is the one place that
 * also writes the opening Inventory_Transaction ledger row inside the same transaction (Req
 * 4.4, 4.9) -- writing the record without it would leave `physicalQuantity` unreconstructable
 * from the ledger (Req 4.7). Idempotency is a find-before-create check on the same
 * `{ item, location, batch }` business key the model's unique index enforces, since
 * `createInventoryRecord` itself rejects an existing triple with `DUPLICATE_INVENTORY_RECORD`
 * rather than upserting it.
 */
async function seedInventoryRecords(items, locations) {
    const records = new Map();

    for (const { itemCode, locationCode, batch, physicalQuantity } of SEED_INVENTORY_RECORDS) {
        const item = items.get(itemCode);
        const location = locations.get(locationCode);
        if (!item || !location) {
            throw new Error(
                `Seed inventory record names item "${itemCode}" or location "${locationCode}", ` +
                'which is not in SEED_ITEMS / SEED_LOCATIONS.'
            );
        }

        let record = await InventoryRecord.findOne({ item: item._id, location: location._id, batch });
        if (!record) {
            record = await createInventoryRecord({
                item: item._id,
                location: location._id,
                batch,
                physicalQuantity,
            });
        }

        records.set(`${itemCode}:${locationCode}:${batch}`, record);
    }

    return records;
}

/**
 * Load the whole seed dataset.
 *
 * The steps run in dependency order and each returns its documents keyed by business key,
 * so a later step can look an id up without querying again. Task 6.5 adds the Work_Order
 * step at the end of this function using `items`, `locations`, and `users`.
 *
 * @param {Record<string, string>} passwords validated seed passwords, keyed by variable name
 */
async function seed(passwords) {
    const locations = await seedLocations();
    const categories = await seedCategories();
    const items = await seedItems(categories);
    const users = await seedUsers(passwords, locations);
    const inventoryRecords = await seedInventoryRecords(items, locations);

    return { locations, categories, items, users, inventoryRecords };
}

/** One line per seeded User: email, Role, and the variable its password came from. */
function reportUsers(users) {
    console.log('Seeded users (passwords come from the environment, never from a file):');
    for (const { email, role, passwordVar } of SEED_USERS) {
        console.log(`  ${role.padEnd(15)} ${email.padEnd(28)} password from ${passwordVar}`);
    }
    console.log(`  ${users.size} user document(s) present.`);
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

    await connect(config.mongoUri);

    try {
        const { locations, categories, items, users, inventoryRecords } = await seed(
            passwordCheck.passwords
        );
        reportUsers(users);
        console.log(
            `Seeded reference data: ${locations.size} location(s), ` +
            `${categories.size} category/categories, ${items.size} item(s), ` +
            `${inventoryRecords.size} inventory record(s).`
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
        // One message, no stack trace of the caller's making: enough to act on, and no
        // secret value, because passwords are never carried on an error.
        console.error(`Seed failed: ${error.message}`);
        process.exitCode = 1;
    });

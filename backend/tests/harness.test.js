// backend/tests/harness.test.js -- proves the test harness itself is sound: the suite runs
// against a real MySQL database that can genuinely commit and roll back transactions, and the
// per-test reset actually resets (Req 12.8, 12.9, 12.11).
//
// These tests exist because every other test file trusts the harness. If the per-test reset
// silently stopped clearing a table, tests would start passing or failing depending on the
// order they ran in, and the cause would be invisible from any individual failure. If
// transactions were not really transactional, every rollback assertion in the suite would pass
// without proving anything.
//
// Rewritten from the MongoDB version, which asserted the deployment reported a replica-set
// name. MySQL needs no such deployment shape, so the equivalent checks are: the schema is
// present and InnoDB, a transaction really rolls back, and the reset leaves the fixture state.

const { query } = require('../src/db/pool');
const { newId } = require('../src/db/id');
const { withTransaction } = require('../src/db/withTransaction');
const { checkStorageEngines, getServerVersion } = require('../src/db/connect');
const { getInUseConnectionCount } = require('./setup/poolCount');
const {
    FIXTURE_USERS,
    FIXTURE_ITEMS,
    FIXTURE_LOCATIONS,
    FIXTURE_INVENTORY_RECORDS,
} = require('./setup/seedFixture');

describe('the test database (Req 12.8, 12.9)', () => {
    test('runs against a real MySQL server', async () => {
        const version = await getServerVersion();
        // Transactions and CHECK constraints both need 8.0.16+; the schema relies on each.
        expect(version).toMatch(/^\d+\.\d+/);
        expect(Number.parseInt(version, 10)).toBeGreaterThanOrEqual(8);
    });

    test('uses a database whose name marks it as the throwaway test database', async () => {
        const rows = await query('SELECT DATABASE() AS db');
        // globalSetup derives it by suffixing the application's database name, so a test run
        // can never write to the database the developer's own server uses.
        expect(rows[0].db).toMatch(/_test$/);
    });

    test('has the whole schema present and on InnoDB', async () => {
        const { missing, nonInnoDb } = await checkStorageEngines();
        expect(missing).toEqual([]);
        expect(nonInnoDb).toEqual([]);
    });
});

describe('transactions are real (Req 8.2, 12.8)', () => {
    test('a committed transaction persists its writes', async () => {
        const id = newId();

        await withTransaction(async (tx) => {
            await tx.query('INSERT INTO categories (id, name) VALUES (?, ?)', [id, 'Harness Commit']);
        });

        const rows = await query('SELECT name FROM categories WHERE id = ?', [id]);
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Harness Commit');
    });

    test('a failed transaction rolls back every write it made, not just the failing one', async () => {
        const firstId = newId();
        const secondId = newId();
        const sentinel = new Error('harness: deliberate failure after a successful write');

        await expect(
            withTransaction(async (tx) => {
                // Both inserts are legal on their own; the throw comes after the first.
                await tx.query('INSERT INTO categories (id, name) VALUES (?, ?)', [firstId, 'Harness A']);
                await tx.query('INSERT INTO categories (id, name) VALUES (?, ?)', [secondId, 'Harness B']);
                throw sentinel;
            })
        ).rejects.toBe(sentinel);

        // If ROLLBACK were being ignored -- as it silently would be on a non-InnoDB engine --
        // these rows would still be here and this is the assertion that would catch it.
        const rows = await query('SELECT id FROM categories WHERE id IN (?, ?)', [firstId, secondId]);
        expect(rows).toHaveLength(0);
    });

    test('releases its pooled connection on both the committing and the failing path', async () => {
        const before = getInUseConnectionCount();

        await withTransaction(async (tx) => {
            await tx.query('SELECT 1');
        });

        await expect(
            withTransaction(async () => {
                throw new Error('harness: failing path');
            })
        ).rejects.toThrow('harness: failing path');

        // A transaction that failed to release its connection would leak one here, and after
        // `connectionLimit` such requests the pool would block forever (Req 8.3).
        expect(getInUseConnectionCount()).toBe(before);
    });
});

describe('the per-test reset (Req 12.11)', () => {
    // This test writes rows; the one after it asserts they are gone. Together they prove the
    // reset runs between tests -- which no single test could show on its own.
    test('a test may write rows freely', async () => {
        await query('INSERT INTO categories (id, name) VALUES (?, ?)', [newId(), 'Leak Canary']);
        await query(
            `INSERT INTO customer_orders (id, customer_name, item_id, location_id, quantity)
             VALUES (?, 'Leak Canary Order', ?, ?, 1)`,
            [newId(), FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id]
        );

        expect(await query('SELECT id FROM categories WHERE name = ?', ['Leak Canary'])).toHaveLength(1);
    });

    test('rows written by the previous test are gone, and the fixture is back', async () => {
        // The canaries the previous test wrote.
        expect(await query('SELECT id FROM categories WHERE name = ?', ['Leak Canary'])).toHaveLength(0);
        expect(
            await query('SELECT id FROM customer_orders WHERE customer_name = ?', ['Leak Canary Order'])
        ).toHaveLength(0);

        // And the fixture state every other test file assumes is present again.
        const users = await query('SELECT id, email, role FROM users ORDER BY email');
        expect(users).toHaveLength(3);
        expect(users.map((user) => user.role).sort()).toEqual(['Admin', 'OperationsUser', 'SalesUser']);
        expect(users.map((user) => user.id)).toContain(FIXTURE_USERS.Admin.id);

        const records = await query('SELECT id FROM inventory_records ORDER BY id');
        expect(records).toHaveLength(3);
        expect(records.map((row) => row.id)).toContain(
            FIXTURE_INVENTORY_RECORDS.widgetMainBatchA.id
        );
    });

    test('the fixture satisfies the ledger reconstruction property on arrival (Req 4.7)', async () => {
        // The fixture writes ledger rows alongside its records rather than inserting balances
        // out of nowhere, so this holds before any test has moved anything.
        const rows = await query(
            `SELECT ir.id,
                    ir.physical_quantity AS physical,
                    ir.reserved_quantity AS reserved,
                    COALESCE(SUM(it.physical_delta), 0) AS ledgerPhysical,
                    COALESCE(SUM(it.reserved_delta), 0) AS ledgerReserved
               FROM inventory_records ir
               LEFT JOIN inventory_transactions it ON it.inventory_record_id = ir.id
              GROUP BY ir.id, ir.physical_quantity, ir.reserved_quantity`
        );

        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(Number(row.ledgerPhysical)).toBe(row.physical);
            expect(Number(row.ledgerReserved)).toBe(row.reserved);
        }
    });
});

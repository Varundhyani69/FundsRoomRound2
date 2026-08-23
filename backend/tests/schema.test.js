// backend/tests/schema.test.js -- asserts the DATABASE itself refuses illegal data.
//
// This replaced `userModel.test.js` and `modelRegistration.test.js`, which tested Mongoose
// schema behaviour that no longer exists. Their relational equivalent is more valuable: under
// Mongoose, "reserved cannot exceed physical" was enforced only by application code, so a bug
// anywhere in that code could persist a nonsensical row. Here the same rules are declared in
// src/db/schema.sql as CHECK constraints, UNIQUE indexes and FOREIGN KEYs, which hold even
// against a write that bypasses every service in this project.
//
// So these tests deliberately write raw SQL rather than going through the services: the point
// is to prove the constraints stand on their own, independently of the guards that also
// enforce them.

const { query } = require('../src/db/pool');
const { newId } = require('../src/db/id');
const { checkStorageEngines } = require('../src/db/connect');
const { FIXTURE_ITEMS, FIXTURE_LOCATIONS, FIXTURE_INVENTORY_RECORDS } = require('./setup/seedFixture');

/**
 * Runs a statement expected to fail, and returns the MySQL error code it failed with.
 * Fails the test if the statement was accepted.
 */
async function rejectionCodeOf(sql, params = []) {
    try {
        await query(sql, params);
    } catch (error) {
        return error.code;
    }
    throw new Error('Expected the database to reject this statement, but it was accepted.');
}

describe('storage engine (Req 12.9)', () => {
    test('every transactional table is InnoDB, so BEGIN/COMMIT/ROLLBACK are honoured', async () => {
        const { nonInnoDb, missing } = await checkStorageEngines();

        // On any other engine MySQL accepts the transaction statements and silently ignores
        // them, which would make every rollback assertion in this suite pass for the wrong
        // reason.
        expect(nonInnoDb).toEqual([]);
        expect(missing).toEqual([]);
    });
});

describe('inventory_records invariants (Req 3.8, 3.9)', () => {
    test('rejects an insert whose reserved quantity exceeds its physical quantity', async () => {
        const code = await rejectionCodeOf(
            `INSERT INTO inventory_records
                 (id, item_id, location_id, batch, physical_quantity, reserved_quantity)
             VALUES (?, ?, ?, 'SCHEMA-1', 5, 10)`,
            [newId(), FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id]
        );
        expect(code).toBe('ER_CHECK_CONSTRAINT_VIOLATED');
    });

    test('rejects an update that would push reserved above physical', async () => {
        const record = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB; // physical 50, reserved 0
        const code = await rejectionCodeOf(
            'UPDATE inventory_records SET reserved_quantity = ? WHERE id = ?',
            [999, record.id]
        );
        expect(code).toBe('ER_CHECK_CONSTRAINT_VIOLATED');
    });

    test('rejects an update that would drive physical quantity negative', async () => {
        const record = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB;
        const code = await rejectionCodeOf(
            'UPDATE inventory_records SET physical_quantity = physical_quantity - ? WHERE id = ?',
            [1000, record.id]
        );
        // UNSIGNED refuses the negative value outright.
        expect(code).toBe('ER_DATA_OUT_OF_RANGE');
    });

    test('rejects a duplicate item + location + batch triple (Req 3.6, 3.7)', async () => {
        const existing = FIXTURE_INVENTORY_RECORDS.widgetMainBatchA;
        const code = await rejectionCodeOf(
            `INSERT INTO inventory_records
                 (id, item_id, location_id, batch, physical_quantity, reserved_quantity)
             VALUES (?, ?, ?, ?, 1, 0)`,
            [newId(), existing.item, existing.location, existing.batch]
        );
        expect(code).toBe('ER_DUP_ENTRY');
    });

    test('treats batch identifiers case-sensitively, so "a" and "A" are different batches', async () => {
        const existing = FIXTURE_INVENTORY_RECORDS.widgetMainBatchA; // batch 'A'

        // Lowercase 'a' must be accepted alongside uppercase 'A'. A case-insensitive
        // collation -- MySQL's default -- would reject this as a duplicate, silently merging
        // two distinct batches.
        await query(
            `INSERT INTO inventory_records
                 (id, item_id, location_id, batch, physical_quantity, reserved_quantity)
             VALUES (?, ?, ?, 'a', 1, 0)`,
            [newId(), existing.item, existing.location]
        );

        const rows = await query(
            'SELECT batch FROM inventory_records WHERE item_id = ? AND location_id = ? ORDER BY BINARY batch',
            [existing.item, existing.location]
        );
        expect(rows.map((row) => row.batch)).toContain('A');
        expect(rows.map((row) => row.batch)).toContain('a');
    });

    test('rejects a record referencing an item that does not exist', async () => {
        const code = await rejectionCodeOf(
            `INSERT INTO inventory_records
                 (id, item_id, location_id, batch, physical_quantity)
             VALUES (?, ?, ?, 'SCHEMA-FK', 1)`,
            [newId(), newId(), FIXTURE_LOCATIONS.main.id]
        );
        expect(code).toBe('ER_NO_REFERENCED_ROW_2');
    });
});

describe('inventory_transactions idempotency key (Req 4.5)', () => {
    test('rejects a second row reusing a movement reference', async () => {
        const record = FIXTURE_INVENTORY_RECORDS.widgetMainBatchA;
        const reference = `schema-test-${newId()}`;

        await query(
            `INSERT INTO inventory_transactions
                 (id, inventory_record_id, physical_delta, reserved_delta, movement_reference)
             VALUES (?, ?, 1, 0, ?)`,
            [newId(), record.id, reference]
        );

        // This UNIQUE index is the whole idempotency mechanism: it is what makes a replayed or
        // concurrent duplicate movement fail at the database rather than being applied twice.
        const code = await rejectionCodeOf(
            `INSERT INTO inventory_transactions
                 (id, inventory_record_id, physical_delta, reserved_delta, movement_reference)
             VALUES (?, ?, 1, 0, ?)`,
            [newId(), record.id, reference]
        );
        expect(code).toBe('ER_DUP_ENTRY');
    });
});

describe('internal_transfers constraints (Req 6.2, 15.2)', () => {
    const insertTransfer = (source, destination, quantity, receivedQuantity = 0) =>
        rejectionCodeOf(
            `INSERT INTO internal_transfers
                 (id, item_id, batch, source_location_id, destination_location_id,
                  quantity, received_quantity)
             VALUES (?, ?, 'A', ?, ?, ?, ?)`,
            [newId(), FIXTURE_ITEMS.widget.id, source, destination, quantity, receivedQuantity]
        );

    test('rejects a transfer whose source and destination are the same location', async () => {
        const code = await insertTransfer(FIXTURE_LOCATIONS.main.id, FIXTURE_LOCATIONS.main.id, 5);
        expect(code).toBe('ER_CHECK_CONSTRAINT_VIOLATED');
    });

    test('rejects a received quantity greater than the transfer quantity', async () => {
        const code = await insertTransfer(
            FIXTURE_LOCATIONS.main.id,
            FIXTURE_LOCATIONS.secondary.id,
            10,
            11
        );
        expect(code).toBe('ER_CHECK_CONSTRAINT_VIOLATED');
    });

    test('rejects a transfer quantity of zero', async () => {
        const code = await insertTransfer(
            FIXTURE_LOCATIONS.main.id,
            FIXTURE_LOCATIONS.secondary.id,
            0
        );
        expect(code).toBe('ER_CHECK_CONSTRAINT_VIOLATED');
    });
});

describe('users constraints (Req 1.1)', () => {
    test('rejects a duplicate email', async () => {
        const code = await rejectionCodeOf(
            `INSERT INTO users (id, email, password_hash, role)
             VALUES (?, 'admin@fixture.test', ?, 'Admin')`,
            [newId(), 'x'.repeat(60)]
        );
        expect(code).toBe('ER_DUP_ENTRY');
    });

    test('rejects a role outside the declared set', async () => {
        const code = await rejectionCodeOf(
            `INSERT INTO users (id, email, password_hash, role)
             VALUES (?, ?, ?, 'Root')`,
            [newId(), `schema-${newId()}@fixture.test`, 'x'.repeat(60)]
        );
        // The ENUM column refuses a value it does not declare.
        expect(code).toBe('WARN_DATA_TRUNCATED');
    });
});

describe('customer_order_reservations cascade (Req 15.3)', () => {
    test('deleting an order removes its reservation lines', async () => {
        const orderId = newId();
        await query(
            `INSERT INTO customer_orders (id, customer_name, item_id, location_id, quantity)
             VALUES (?, 'Schema Test', ?, ?, 5)`,
            [orderId, FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id]
        );
        await query(
            `INSERT INTO customer_order_reservations
                 (id, customer_order_id, item_id, location_id, batch, quantity)
             VALUES (?, ?, ?, ?, 'A', 5)`,
            [newId(), orderId, FIXTURE_ITEMS.widget.id, FIXTURE_LOCATIONS.main.id]
        );

        expect(
            (await query('SELECT COUNT(*) AS n FROM customer_order_reservations WHERE customer_order_id = ?', [orderId]))[0].n
        ).toBe(1);

        await query('DELETE FROM customer_orders WHERE id = ?', [orderId]);

        // ON DELETE CASCADE: a reservation line has no meaning without its order, so it must
        // not survive as an orphan.
        expect(
            (await query('SELECT COUNT(*) AS n FROM customer_order_reservations WHERE customer_order_id = ?', [orderId]))[0].n
        ).toBe(0);
    });
});

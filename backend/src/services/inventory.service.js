// backend/src/services/inventory.service.js -- inventory reads and the one place that
// writes an inventory_records change together with its inventory_transactions ledger row
// (Req 3.7-3.12, 4.2, 4.3, 4.4, 4.6, 4.9, 8.1, 15.5).
//
// Every quantity comparison in this file goes through a named guard function
// (`assertSufficientPhysical`, `assertSufficientAvailable`) rather than being inlined at a
// call site, so the rules live in one readable place and controllers hold none of them
// (Req 15.5). The availability formula itself is not restated here at all -- it comes from
// src/services/availability.js (Req 15.1).
//
// Concurrency, in SQL terms: `applyMovement` takes a row lock with
// `SELECT ... FOR UPDATE` before it reads the balances it is about to change. InnoDB holds
// that lock until the surrounding transaction commits, so two concurrent movements against
// the same record are serialised rather than interleaved: the second one blocks, then reads
// the first one's committed values and re-evaluates the guards against them. That is what
// makes it impossible for two requests to both pass a check and then both write
// (Req 7.4-7.7). A deadlock or lock-wait timeout between two such transactions is a timing
// outcome, not a logical failure, and is retried by src/db/withTransaction.js.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { newId } = require('../db/id');
const { toInventoryRecord } = require('../db/mappers');
const { availableQuantity, locationAvailableQuantity } = require('./availability');
const { openingMovementReference, adjustMovementReference } = require('./movementReference');

// --- error builders -------------------------------------------------------------------
// Built fresh per call because AppError carries a per-request stack.

const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'A referenced item or location does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'No inventory record matches that identifier.');

const duplicateInventoryRecord = () =>
    new AppError(
        ERROR_CODES.DUPLICATE_INVENTORY_RECORD,
        'DUPLICATE_INVENTORY_RECORD',
        'An inventory record already exists for that item, location and batch.'
    );

const duplicateInventoryTransaction = () =>
    new AppError(
        ERROR_CODES.DUPLICATE_INVENTORY_TRANSACTION,
        'DUPLICATE_INVENTORY_TRANSACTION',
        'That movement reference has already been applied.'
    );

const insufficientPhysicalQuantity = () =>
    new AppError(
        ERROR_CODES.INSUFFICIENT_PHYSICAL_QUANTITY,
        'INSUFFICIENT_PHYSICAL_QUANTITY',
        'This movement would drive the physical quantity below zero.'
    );

const insufficientAvailableQuantity = () =>
    new AppError(
        ERROR_CODES.INSUFFICIENT_AVAILABLE_QUANTITY,
        'INSUFFICIENT_AVAILABLE_QUANTITY',
        'This movement would reserve more than is physically on hand.'
    );

/** True for a MySQL unique-index violation. */
const isDuplicateKey = (error) => error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);

// --- guards ----------------------------------------------------------------------------

/**
 * Guard 1 of Req 3.8: physicalQuantity must never go below 0.
 *
 * @param {number} currentPhysicalQuantity the record's physicalQuantity before the movement
 * @param {number} physicalDelta the signed change being applied
 * @throws {AppError} 409 INSUFFICIENT_PHYSICAL_QUANTITY
 */
function assertSufficientPhysical(currentPhysicalQuantity, physicalDelta) {
    if (currentPhysicalQuantity + physicalDelta < 0) {
        throw insufficientPhysicalQuantity();
    }
}

/**
 * Guard 2 of Req 3.8: reservedQuantity must never exceed physicalQuantity.
 *
 * @param {number} currentPhysicalQuantity the record's physicalQuantity before the movement
 * @param {number} currentReservedQuantity the record's reservedQuantity before the movement
 * @param {number} physicalDelta the signed physicalQuantity change being applied
 * @param {number} reservedDelta the signed reservedQuantity change being applied
 * @throws {AppError} 409 INSUFFICIENT_AVAILABLE_QUANTITY
 */
function assertSufficientAvailable(
    currentPhysicalQuantity,
    currentReservedQuantity,
    physicalDelta,
    reservedDelta
) {
    const nextPhysical = currentPhysicalQuantity + physicalDelta;
    const nextReserved = currentReservedQuantity + reservedDelta;
    if (nextReserved > nextPhysical) {
        throw insufficientAvailableQuantity();
    }
}

// --- reads -----------------------------------------------------------------------------

// The JOIN every inventory read shares, aliasing columns as `<relation>_<field>` so
// src/db/mappers.js can rebuild the nested response shape. Declared once so a list read and
// a single read cannot drift apart.
const RECORD_SELECT = `
    SELECT ir.id, ir.batch, ir.physical_quantity, ir.reserved_quantity,
           ir.created_at, ir.updated_at,
           i.id AS item_id, i.code AS item_code, i.name AS item_name,
           c.id AS category_id, c.name AS category_name,
           l.id AS location_id, l.code AS location_code, l.name AS location_name
      FROM inventory_records ir
      JOIN items i     ON i.id = ir.item_id
      JOIN categories c ON c.id = i.category_id
      JOIN locations l ON l.id = ir.location_id`;

/**
 * Reads one record back in the populated response shape, on the caller's connection when one
 * is supplied so a write can return the value it just committed.
 *
 * @param {string} id
 * @param {import('mysql2/promise').PoolConnection} [tx]
 */
async function findRecordById(id, tx = null) {
    const sql = `${RECORD_SELECT} WHERE ir.id = ?`;
    const rows = tx ? (await tx.query(sql, [id]))[0] : await query(sql, [id]);
    return rows.length > 0 ? toInventoryRecord(rows[0]) : null;
}

/**
 * Lists records, optionally filtered by item and/or location (Req 3.3, 3.5).
 *
 * @param {{ item?: string, location?: string }} [filters]
 * @returns {Promise<object[]>}
 */
async function listInventoryRecords({ item, location } = {}) {
    const conditions = [];
    const params = [];

    if (item) {
        conditions.push('ir.item_id = ?');
        params.push(item);
    }
    if (location) {
        conditions.push('ir.location_id = ?');
        params.push(location);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    // Ordered so a list response is stable across calls rather than in storage order, and
    // by batch ascending to match the order reservations consume batches in (Req 15.6).
    const rows = await query(`${RECORD_SELECT}${where} ORDER BY i.code, l.code, ir.batch`, params);
    return rows.map(toInventoryRecord);
}

/**
 * Location_Available_Quantity for one item at one location, summed across every batch
 * (Req 3.5), reporting 0 rather than NOT_FOUND when no record exists (Req 3.12).
 *
 * The summation is done in JS by `locationAvailableQuantity` rather than with SQL's SUM(),
 * so the availability rule has exactly one definition (Req 15.1). The row count here is at
 * most the number of batches of one item at one location, so there is nothing to gain from
 * pushing the arithmetic into the database.
 *
 * @param {{ item: string, location: string }} filters
 * @returns {Promise<{ item: string, location: string, locationAvailableQuantity: number }>}
 */
async function getLocationAvailability({ item, location }) {
    const rows = await query(
        `SELECT physical_quantity, reserved_quantity
           FROM inventory_records
          WHERE item_id = ? AND location_id = ?`,
        [item, location]
    );

    const records = rows.map((row) => ({
        physicalQuantity: row.physical_quantity,
        reservedQuantity: row.reserved_quantity,
    }));

    return { item, location, locationAvailableQuantity: locationAvailableQuantity(records) };
}

// --- the one write path ----------------------------------------------------------------

/**
 * Normalises what a caller may pass as the movement target into a locking SELECT plus its
 * parameters. Accepts a record id (a string, or an object carrying `id`), or an
 * `{ item, location, batch }` triple such as the one transfer.service.js passes when it
 * knows the record's identity but not its id.
 *
 * @param {string|{ id?: string, item?: string, location?: string, batch?: string }} locator
 * @returns {{ sql: string, params: any[] }}
 */
function toLockingSelect(locator) {
    const base = `SELECT id, physical_quantity, reserved_quantity FROM inventory_records`;

    if (typeof locator === 'string') {
        return { sql: `${base} WHERE id = ? FOR UPDATE`, params: [locator] };
    }
    if (locator && locator.id) {
        return { sql: `${base} WHERE id = ? FOR UPDATE`, params: [String(locator.id)] };
    }
    return {
        sql: `${base} WHERE item_id = ? AND location_id = ? AND batch = ? FOR UPDATE`,
        params: [locator.item, locator.location, locator.batch],
    };
}

/**
 * The single place that writes an inventory_records change together with its
 * inventory_transactions ledger row, always on the caller's transaction (Req 4.4, 8.1).
 *
 * @param {string|object} locator the target record's id, or an `{ item, location, batch }` triple
 * @param {{ physicalDelta: number, reservedDelta: number, movementReference: string, createdBy?: string|null }} movement
 * @param {import('mysql2/promise').PoolConnection} tx the caller's transaction connection
 * @returns {Promise<string>} the affected record's id
 * @throws {AppError} 404 NOT_FOUND when no record matches; 409 INSUFFICIENT_PHYSICAL_QUANTITY,
 *   INSUFFICIENT_AVAILABLE_QUANTITY, or DUPLICATE_INVENTORY_TRANSACTION
 */
async function applyMovement(locator, movement, tx) {
    const { physicalDelta, reservedDelta, movementReference, createdBy = null } = movement;

    // FOR UPDATE: locks the row for the rest of this transaction, so the balances read here
    // cannot be changed by anyone else before the UPDATE below lands. This is what removes
    // the read-then-write race entirely -- a second transaction targeting the same row waits
    // here, then reads post-commit values (Req 7.4).
    const locking = toLockingSelect(locator);
    const [currentRows] = await tx.query(locking.sql, locking.params);
    if (currentRows.length === 0) {
        throw notFound();
    }

    const current = currentRows[0];
    const currentPhysical = current.physical_quantity;
    const currentReserved = current.reserved_quantity;

    // The guards decide legality and choose the error code (Req 15.5). They run against
    // values read under the row lock, so their verdict is still true at write time.
    assertSufficientPhysical(currentPhysical, physicalDelta);
    assertSufficientAvailable(currentPhysical, currentReserved, physicalDelta, reservedDelta);

    const nextPhysical = currentPhysical + physicalDelta;
    const nextReserved = currentReserved + reservedDelta;

    // The guard predicates are repeated in the WHERE clause as defence in depth: if a future
    // change ever let a caller reach this line without the guards above, the database would
    // still refuse rather than write an illegal row. Explicit target values are set (rather
    // than `col = col + ?`) because the row lock already makes the computed values
    // authoritative.
    const [updateResult] = await tx.query(
        `UPDATE inventory_records
            SET physical_quantity = ?, reserved_quantity = ?
          WHERE id = ? AND ? >= 0 AND ? <= ?`,
        [nextPhysical, nextReserved, current.id, nextPhysical, nextReserved, nextPhysical]
    );

    // `affectedRows` counts rows CHANGED, so a movement of (0, 0) legitimately reports 0
    // without anything being wrong. Only treat 0 as a failure when the row genuinely should
    // have changed.
    const shouldHaveChanged = nextPhysical !== currentPhysical || nextReserved !== currentReserved;
    if (updateResult.affectedRows !== 1 && shouldHaveChanged) {
        // Unreachable while the guards above are correct; kept so a future regression fails
        // loudly rather than silently skipping the write.
        throw insufficientAvailableQuantity();
    }

    // The ledger row. Its UNIQUE movement_reference is what makes a replayed or concurrent
    // duplicate fail at the database rather than being applied twice (Req 4.5).
    try {
        await tx.query(
            `INSERT INTO inventory_transactions
                 (id, inventory_record_id, physical_delta, reserved_delta, movement_reference, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [newId(), current.id, physicalDelta, reservedDelta, movementReference, createdBy]
        );
    } catch (error) {
        if (isDuplicateKey(error)) {
            throw duplicateInventoryTransaction();
        }
        throw error;
    }

    return current.id;
}

// --- writes ----------------------------------------------------------------------------

/**
 * Creates an inventory record with an opening balance and its opening ledger row, both in
 * one transaction (Req 3.10, 3.11, 4.9).
 *
 * @param {{ item: string, location: string, batch: string, physicalQuantity: number, createdBy?: string|null }} input
 * @returns {Promise<object>} the created record in the populated response shape
 * @throws {AppError} 400 INVALID_REFERENCE; 409 DUPLICATE_INVENTORY_RECORD
 */
async function createInventoryRecord({ item, location, batch, physicalQuantity, createdBy = null }) {
    return withTransaction(async (tx) => {
        // Existence of both references is checked explicitly so the caller gets
        // INVALID_REFERENCE (400) rather than the foreign key's raw failure (Req 3.11).
        const [refRows] = await tx.query(
            `SELECT
                 (SELECT COUNT(*) FROM items     WHERE id = ?) AS itemCount,
                 (SELECT COUNT(*) FROM locations WHERE id = ?) AS locationCount`,
            [item, location]
        );
        if (refRows[0].itemCount !== 1 || refRows[0].locationCount !== 1) {
            throw invalidReference();
        }

        // The id is generated up front so the opening ledger row can reference the record
        // and the movement reference can embed the record's own id (Req 4.9).
        const id = newId();

        try {
            await tx.query(
                `INSERT INTO inventory_records
                     (id, item_id, location_id, batch, physical_quantity, reserved_quantity)
                 VALUES (?, ?, ?, ?, ?, 0)`,
                [id, item, location, batch, physicalQuantity]
            );
        } catch (error) {
            // The UNIQUE (item_id, location_id, batch) index refused it (Req 3.7).
            if (isDuplicateKey(error)) {
                throw duplicateInventoryRecord();
            }
            throw error;
        }

        // The opening balance is booked as a movement like any other, so the ledger can
        // reconstruct physical_quantity from its deltas alone (Req 4.7, 4.9). An opening
        // quantity of 0 still writes its row, so every record has a ledger origin.
        await tx.query(
            `INSERT INTO inventory_transactions
                 (id, inventory_record_id, physical_delta, reserved_delta, movement_reference, created_by)
             VALUES (?, ?, ?, 0, ?, ?)`,
            [newId(), id, physicalQuantity, openingMovementReference(id), createdBy]
        );

        return findRecordById(id, tx);
    });
}

/**
 * Applies an IN or OUT movement to one existing record (Req 4.2, 4.3, 4.6).
 *
 * @param {{ recordId: string, direction: 'IN'|'OUT', quantity: number, movementReference: string, createdBy?: string|null }} input
 * @returns {Promise<object>} the adjusted record in the populated response shape
 */
async function adjustInventoryRecord({
    recordId,
    direction,
    quantity,
    movementReference: clientRef,
    createdBy = null,
}) {
    return withTransaction(async (tx) => {
        // OUT is the same movement with the sign flipped, so there is one write path rather
        // than a branch per direction.
        const physicalDelta = direction === 'OUT' ? -quantity : quantity;

        await applyMovement(
            recordId,
            {
                physicalDelta,
                reservedDelta: 0,
                // The client's reference is namespaced with the record it targets, so the
                // same human-supplied string stays usable against a different record while a
                // replay against THIS record is rejected (Req 4.6).
                movementReference: adjustMovementReference(recordId, clientRef),
                createdBy,
            },
            tx
        );

        return findRecordById(recordId, tx);
    });
}

module.exports = {
    // guards, exported so tests can exercise them directly and so no caller re-implements
    // a quantity comparison of its own (Req 15.5)
    assertSufficientPhysical,
    assertSufficientAvailable,
    // the one write primitive every stock movement goes through
    applyMovement,
    // reads
    listInventoryRecords,
    getLocationAvailability,
    findRecordById,
    // writes
    createInventoryRecord,
    adjustInventoryRecord,
    // shared with the other services that map MySQL duplicate-key failures
    isDuplicateKey,
    RECORD_SELECT,
};

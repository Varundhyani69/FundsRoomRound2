// Inventory service: reads and the single write path (applyMovement) that pairs every
// inventory_records change with its inventory_transactions ledger row.
// Concurrency: SELECT ... FOR UPDATE serialises movements against the same record.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { newId } = require('../db/id');
const { toInventoryRecord } = require('../db/mappers');
const { availableQuantity, locationAvailableQuantity } = require('./availability');
const { openingMovementReference, adjustMovementReference } = require('./movementReference');

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

/**
 * Guard: physicalQuantity must never go below 0.
 */
function assertSufficientPhysical(currentPhysicalQuantity, physicalDelta) {
    if (currentPhysicalQuantity + physicalDelta < 0) {
        throw insufficientPhysicalQuantity();
    }
}

/**
 * Guard: reservedQuantity must never exceed physicalQuantity.
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

/** Shared SELECT for populated inventory record reads. */
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

/** Reads one record in the populated response shape. */
async function findRecordById(id, tx = null) {
    const sql = `${RECORD_SELECT} WHERE ir.id = ?`;
    const rows = tx ? (await tx.query(sql, [id]))[0] : await query(sql, [id]);
    return rows.length > 0 ? toInventoryRecord(rows[0]) : null;
}

/** Lists records, optionally filtered by item and/or location. */
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
    const rows = await query(`${RECORD_SELECT}${where} ORDER BY i.code, l.code, ir.batch`, params);
    return rows.map(toInventoryRecord);
}

/** Location available quantity for one item at one location, summed across batches. */
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

/**
 * Builds a locking SELECT from a record locator (id string, {id} object, or {item, location, batch} triple).
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
 * The single write path: updates an inventory record and inserts its ledger row in one transaction.
 * @param {string|object} locator target record id or {item, location, batch} triple
 * @param {{ physicalDelta: number, reservedDelta: number, movementReference: string, createdBy?: string|null }} movement
 * @param {import('mysql2/promise').PoolConnection} tx caller's transaction
 * @returns {Promise<string>} the affected record's id
 */
async function applyMovement(locator, movement, tx) {
    const { physicalDelta, reservedDelta, movementReference, createdBy = null } = movement;

    const locking = toLockingSelect(locator);
    const [currentRows] = await tx.query(locking.sql, locking.params);
    if (currentRows.length === 0) {
        throw notFound();
    }

    const current = currentRows[0];
    const currentPhysical = current.physical_quantity;
    const currentReserved = current.reserved_quantity;

    assertSufficientPhysical(currentPhysical, physicalDelta);
    assertSufficientAvailable(currentPhysical, currentReserved, physicalDelta, reservedDelta);

    const nextPhysical = currentPhysical + physicalDelta;
    const nextReserved = currentReserved + reservedDelta;

    // Defence in depth: the WHERE predicates repeat the guard logic at the DB level.
    const [updateResult] = await tx.query(
        `UPDATE inventory_records
            SET physical_quantity = ?, reserved_quantity = ?
          WHERE id = ? AND ? >= 0 AND ? <= ?`,
        [nextPhysical, nextReserved, current.id, nextPhysical, nextReserved, nextPhysical]
    );

    const shouldHaveChanged = nextPhysical !== currentPhysical || nextReserved !== currentReserved;
    if (updateResult.affectedRows !== 1 && shouldHaveChanged) {
        throw insufficientAvailableQuantity();
    }

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

/**
 * Creates an inventory record with an opening balance and ledger row in one transaction.
 */
async function createInventoryRecord({ item, location, batch, physicalQuantity, createdBy = null }) {
    return withTransaction(async (tx) => {
        const [refRows] = await tx.query(
            `SELECT
                 (SELECT COUNT(*) FROM items     WHERE id = ?) AS itemCount,
                 (SELECT COUNT(*) FROM locations WHERE id = ?) AS locationCount`,
            [item, location]
        );
        if (refRows[0].itemCount !== 1 || refRows[0].locationCount !== 1) {
            throw invalidReference();
        }

        const id = newId();

        try {
            await tx.query(
                `INSERT INTO inventory_records
                     (id, item_id, location_id, batch, physical_quantity, reserved_quantity)
                 VALUES (?, ?, ?, ?, ?, 0)`,
                [id, item, location, batch, physicalQuantity]
            );
        } catch (error) {
            if (isDuplicateKey(error)) {
                throw duplicateInventoryRecord();
            }
            throw error;
        }

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
 * Applies an IN or OUT adjustment to one existing record.
 */
async function adjustInventoryRecord({
    recordId,
    direction,
    quantity,
    movementReference: clientRef,
    createdBy = null,
}) {
    return withTransaction(async (tx) => {
        const physicalDelta = direction === 'OUT' ? -quantity : quantity;

        await applyMovement(
            recordId,
            {
                physicalDelta,
                reservedDelta: 0,
                movementReference: adjustMovementReference(recordId, clientRef),
                createdBy,
            },
            tx
        );

        return findRecordById(recordId, tx);
    });
}

module.exports = {
    assertSufficientPhysical,
    assertSufficientAvailable,
    applyMovement,
    listInventoryRecords,
    getLocationAvailability,
    findRecordById,
    createInventoryRecord,
    adjustInventoryRecord,
    isDuplicateKey,
    RECORD_SELECT,
};

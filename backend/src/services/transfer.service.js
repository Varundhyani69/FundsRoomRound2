// backend/src/services/transfer.service.js -- the Transfer_Service: the Internal_Transfer
// lifecycle Requested -> Dispatched -> Received, and the two inventory movements that
// lifecycle causes (Req 6.1-6.16, 15.2, 15.5).
//
// The rule the brief is most specific about is where stock is visible mid-flight: a dispatch
// reduces the SOURCE only, and the DESTINATION is not increased until receipt, so units in
// transit appear at neither end. That is why dispatch and receive are two separate
// transactions writing two separate ledger rows, rather than one transfer operation
// (Req 6.3, 6.6, 6.7).
//
// Every quantity comparison and every status comparison in this file goes through a named
// guard (`assertDifferentLocations`, `assertTransferTransition`) rather than being inlined,
// so the rules are readable in one place and controllers hold none of them (Req 15.5).

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { newId } = require('../db/id');
const { toInternalTransfer } = require('../db/mappers');
const { availableQuantity } = require('./availability');
const { applyMovement, isDuplicateKey } = require('./inventory.service');
const { transferMovementReference } = require('./movementReference');

// --- error builders -------------------------------------------------------------------

const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'The referenced item, location, or source batch does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'Transfer not found.');

const sameLocationTransfer = () =>
    new AppError(
        ERROR_CODES.SAME_LOCATION_TRANSFER,
        'SAME_LOCATION_TRANSFER',
        'A transfer must move stock between two different locations.'
    );

const invalidStatusTransition = () =>
    new AppError(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        'INVALID_STATUS_TRANSITION',
        'This status change is not the successor of the current status.'
    );

const transferAlreadyReceived = () =>
    new AppError(
        ERROR_CODES.TRANSFER_ALREADY_RECEIVED,
        'TRANSFER_ALREADY_RECEIVED',
        'This transfer has already been received.'
    );

const insufficientAvailableQuantity = () =>
    new AppError(
        ERROR_CODES.INSUFFICIENT_AVAILABLE_QUANTITY,
        'INSUFFICIENT_AVAILABLE_QUANTITY',
        'The source location does not have enough available quantity for this transfer.'
    );

// --- guards ----------------------------------------------------------------------------

/**
 * Req 6.2: the two endpoints of a transfer must differ. The schema carries the same rule as a
 * CHECK constraint, but this guard runs first so the caller gets a 400 with a specific code
 * rather than a constraint violation.
 *
 * @throws {AppError} 400 SAME_LOCATION_TRANSFER
 */
function assertDifferentLocations(sourceLocation, destinationLocation) {
    if (String(sourceLocation) === String(destinationLocation)) {
        throw sameLocationTransfer();
    }
}

// The one Transfer_Status transition rule, expressed as "target -> its one legal
// predecessor" (Req 6.10). `Requested` has no entry: nothing transitions into it, it is only
// ever the default at creation.
const LEGAL_PREDECESSOR = {
    Dispatched: 'Requested',
    Received: 'Dispatched',
};

/**
 * The named guard that decides whether a dispatch or receipt reaching a Transfer_Status is
 * legal (Req 6.10).
 *
 * The one carve-out is Req 6.9: a receipt against a transfer that already holds `Received` is
 * reported as the business-meaningful `TRANSFER_ALREADY_RECEIVED` rather than the generic
 * `INVALID_STATUS_TRANSITION`, which is what makes a second, concurrent, or replayed receipt
 * read as "already done" to the caller instead of merely "invalid" (Req 6.9, 6.16). Every
 * other illegal pairing falls through to `INVALID_STATUS_TRANSITION`.
 *
 * @throws {AppError} 409 TRANSFER_ALREADY_RECEIVED or 409 INVALID_STATUS_TRANSITION
 */
function assertTransferTransition(currentStatus, targetStatus) {
    if (targetStatus === 'Received' && currentStatus === 'Received') {
        throw transferAlreadyReceived();
    }
    if (LEGAL_PREDECESSOR[targetStatus] !== currentStatus) {
        throw invalidStatusTransition();
    }
}

// --- reads -----------------------------------------------------------------------------

// The JOIN every transfer read shares. Both locations are joined separately and aliased with
// `source_location_*` / `destination_location_*` prefixes, which is what lets one flat row
// carry two locations for src/db/mappers.js to rebuild (Req 6.1).
const TRANSFER_SELECT = `
    SELECT t.id, t.batch, t.quantity, t.received_quantity, t.status,
           t.created_at, t.dispatched_at, t.received_at,
           i.id AS item_id, i.code AS item_code, i.name AS item_name,
           c.id AS category_id, c.name AS category_name,
           sl.id AS source_location_id, sl.code AS source_location_code, sl.name AS source_location_name,
           dl.id AS destination_location_id, dl.code AS destination_location_code, dl.name AS destination_location_name
      FROM internal_transfers t
      JOIN items i      ON i.id = t.item_id
      JOIN categories c ON c.id = i.category_id
      JOIN locations sl ON sl.id = t.source_location_id
      JOIN locations dl ON dl.id = t.destination_location_id`;

/** Reads one transfer in the populated response shape, or null when absent. */
async function findTransferById(id) {
    const rows = await query(`${TRANSFER_SELECT} WHERE t.id = ?`, [id]);
    return rows.length > 0 ? toInternalTransfer(rows[0]) : null;
}

/**
 * Lists Internal_Transfers, optionally filtered by status (Req 6.1).
 *
 * @param {{ status?: string }} [filters]
 * @returns {Promise<object[]>}
 */
async function listTransfers({ status } = {}) {
    const where = status ? ' WHERE t.status = ?' : '';
    const params = status ? [status] : [];
    const rows = await query(
        `${TRANSFER_SELECT}${where} ORDER BY t.created_at DESC, t.id`,
        params
    );
    return rows.map(toInternalTransfer);
}

// --- writes ----------------------------------------------------------------------------

/**
 * Creates an Internal_Transfer with Transfer_Status `Requested` (Req 6.1). No inventory write
 * happens here: stock only moves on dispatch and receipt (Req 6.3).
 *
 * @param {{ item: string, batch: string, sourceLocation: string, destinationLocation: string, quantity: number, createdBy?: string|null }} input
 * @returns {Promise<object>} the created transfer in the populated response shape
 * @throws {AppError} 400 SAME_LOCATION_TRANSFER; 400 INVALID_REFERENCE
 */
async function createTransfer({
    item,
    batch,
    sourceLocation,
    destinationLocation,
    quantity,
    createdBy = null,
}) {
    // Checked before any existence lookup, so an obviously nonsensical transfer costs no
    // queries.
    assertDifferentLocations(sourceLocation, destinationLocation);

    // Trimmed to match how inventory_records.batch is stored and compared (Req 3.1, 3.6), so
    // a batch differing only by surrounding whitespace still finds the source record.
    const trimmedBatch = typeof batch === 'string' ? batch.trim() : batch;

    const refRows = await query(
        `SELECT
             (SELECT COUNT(*) FROM items     WHERE id = ?) AS itemCount,
             (SELECT COUNT(*) FROM locations WHERE id = ?) AS sourceCount,
             (SELECT COUNT(*) FROM locations WHERE id = ?) AS destinationCount,
             (SELECT COUNT(*) FROM inventory_records
               WHERE item_id = ? AND location_id = ? AND batch = ?) AS sourceRecordCount`,
        [item, sourceLocation, destinationLocation, item, sourceLocation, trimmedBatch]
    );
    const row = refRows[0];

    if (row.itemCount !== 1 || row.sourceCount !== 1 || row.destinationCount !== 1) {
        throw invalidReference();
    }
    // A batch that does not exist at the source is an invalid reference, not an availability
    // problem: there is nothing to dispatch regardless of quantity (Req 6.14).
    if (row.sourceRecordCount !== 1) {
        throw invalidReference();
    }

    const id = newId();
    await query(
        `INSERT INTO internal_transfers
             (id, item_id, batch, source_location_id, destination_location_id,
              quantity, received_quantity, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'Requested', ?)`,
        [id, item, trimmedBatch, sourceLocation, destinationLocation, quantity, createdBy]
    );

    return findTransferById(id);
}

/**
 * Dispatches an Internal_Transfer: reduces the source record's physical quantity by the
 * transfer quantity, writes one ledger row, and advances the status to `Dispatched`
 * (Req 6.4). The destination is deliberately untouched (Req 6.3).
 *
 * The availability check happens here, against a read taken inside this transaction, rather
 * than letting `applyMovement`'s generic guard selection choose the code: Req 6.5 requires
 * `INSUFFICIENT_AVAILABLE_QUANTITY` specifically, including when no source record exists at
 * all (availability is then 0), whereas the generic guard would report
 * `INSUFFICIENT_PHYSICAL_QUANTITY` for a quantity exceeding both.
 *
 * @param {string} transferId
 * @returns {Promise<object>} the updated transfer
 * @throws {AppError} 404 NOT_FOUND; 409 INVALID_STATUS_TRANSITION; 409 INSUFFICIENT_AVAILABLE_QUANTITY
 */
async function dispatchTransfer(transferId) {
    await withTransaction(async (tx) => {
        // FOR UPDATE locks the transfer row, so two concurrent dispatches of the same
        // transfer are serialised and the second sees the first's committed status.
        const [transferRows] = await tx.query(
            `SELECT id, item_id, batch, source_location_id, quantity, status
               FROM internal_transfers WHERE id = ? FOR UPDATE`,
            [transferId]
        );
        if (transferRows.length === 0) {
            throw notFound();
        }
        const transfer = transferRows[0];

        assertTransferTransition(transfer.status, 'Dispatched');

        const [sourceRows] = await tx.query(
            `SELECT physical_quantity, reserved_quantity
               FROM inventory_records
              WHERE item_id = ? AND location_id = ? AND batch = ?`,
            [transfer.item_id, transfer.source_location_id, transfer.batch]
        );

        // No source record at all means availability is 0 (Req 6.5's explicit clause).
        const available =
            sourceRows.length > 0
                ? availableQuantity({
                    physicalQuantity: sourceRows[0].physical_quantity,
                    reservedQuantity: sourceRows[0].reserved_quantity,
                })
                : 0;

        if (transfer.quantity > available) {
            throw insufficientAvailableQuantity();
        }

        await applyMovement(
            {
                item: transfer.item_id,
                location: transfer.source_location_id,
                batch: transfer.batch,
            },
            {
                physicalDelta: -transfer.quantity,
                reservedDelta: 0,
                movementReference: transferMovementReference(transfer.id, 'DISPATCH'),
            },
            tx
        );

        await tx.query(
            `UPDATE internal_transfers
                SET status = 'Dispatched', dispatched_at = CURRENT_TIMESTAMP(3)
              WHERE id = ?`,
            [transfer.id]
        );
    });

    return findTransferById(transferId);
}

/**
 * Receives an Internal_Transfer: increases the destination record's physical quantity --
 * creating that record first if it does not yet exist -- writes one ledger row, sets
 * received_quantity, and advances the status to `Received` (Req 6.7, 6.8).
 *
 * The destination record is created inside THIS transaction rather than by calling
 * `createInventoryRecord` (which would open its own), because Req 6.8 requires the creation
 * and the receipt to commit together.
 *
 * Idempotence (Req 6.9, 6.12, 6.16): a receipt against an already-`Received` transfer is
 * rejected by the guard before any write. If two receipts race past that check, the UNIQUE
 * index on movement_reference lets at most one `RECEIPT` ledger row exist; the loser's
 * `applyMovement` fails with DUPLICATE_INVENTORY_TRANSACTION, remapped here to
 * TRANSFER_ALREADY_RECEIVED because that is the business-meaningful code for this path.
 *
 * @param {string} transferId
 * @returns {Promise<object>} the updated transfer
 * @throws {AppError} 404 NOT_FOUND; 409 TRANSFER_ALREADY_RECEIVED; 409 INVALID_STATUS_TRANSITION
 */
async function receiveTransfer(transferId) {
    await withTransaction(async (tx) => {
        const [transferRows] = await tx.query(
            `SELECT id, item_id, batch, destination_location_id, quantity, status
               FROM internal_transfers WHERE id = ? FOR UPDATE`,
            [transferId]
        );
        if (transferRows.length === 0) {
            throw notFound();
        }
        const transfer = transferRows[0];

        assertTransferTransition(transfer.status, 'Received');

        // Find or create the destination record, inside this transaction (Req 6.8).
        const [destRows] = await tx.query(
            `SELECT id FROM inventory_records
              WHERE item_id = ? AND location_id = ? AND batch = ? FOR UPDATE`,
            [transfer.item_id, transfer.destination_location_id, transfer.batch]
        );

        let destinationRecordId;
        if (destRows.length > 0) {
            destinationRecordId = destRows[0].id;
        } else {
            destinationRecordId = newId();
            try {
                // Created at 0 and then moved by applyMovement below, rather than created
                // with the received quantity directly: that keeps every unit of stock
                // traceable to a ledger row, so the balances stay reconstructible from the
                // ledger alone (Req 4.7).
                await tx.query(
                    `INSERT INTO inventory_records
                         (id, item_id, location_id, batch, physical_quantity, reserved_quantity)
                     VALUES (?, ?, ?, ?, 0, 0)`,
                    [
                        destinationRecordId,
                        transfer.item_id,
                        transfer.destination_location_id,
                        transfer.batch,
                    ]
                );
            } catch (error) {
                // A concurrent receipt created the same destination record first. Re-read it
                // rather than failing: both receipts are trying to reach the same state, and
                // the movement_reference index below decides which one actually applies.
                if (!isDuplicateKey(error)) {
                    throw error;
                }
                const [raceRows] = await tx.query(
                    `SELECT id FROM inventory_records
                      WHERE item_id = ? AND location_id = ? AND batch = ?`,
                    [transfer.item_id, transfer.destination_location_id, transfer.batch]
                );
                destinationRecordId = raceRows[0].id;
            }
        }

        try {
            await applyMovement(
                destinationRecordId,
                {
                    physicalDelta: transfer.quantity,
                    reservedDelta: 0,
                    movementReference: transferMovementReference(transfer.id, 'RECEIPT'),
                },
                tx
            );
        } catch (error) {
            // The losing side of a concurrent receipt (Req 6.9, 6.16).
            if (error.code === 'DUPLICATE_INVENTORY_TRANSACTION') {
                throw transferAlreadyReceived();
            }
            throw error;
        }

        await tx.query(
            `UPDATE internal_transfers
                SET status = 'Received',
                    received_quantity = ?,
                    received_at = CURRENT_TIMESTAMP(3)
              WHERE id = ?`,
            [transfer.quantity, transfer.id]
        );
    });

    return findTransferById(transferId);
}

module.exports = {
    // guards, exported so tests exercise them directly and no caller re-implements them
    assertDifferentLocations,
    assertTransferTransition,
    // reads
    listTransfers,
    findTransferById,
    // writes
    createTransfer,
    dispatchTransfer,
    receiveTransfer,
    TRANSFER_SELECT,
};

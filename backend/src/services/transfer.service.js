// Transfer service: the Internal_Transfer lifecycle Requested → Dispatched → Received.
// Dispatch reduces the source; destination is not increased until receipt (units vanish mid-flight).

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { newId } = require('../db/id');
const { toInternalTransfer } = require('../db/mappers');
const { availableQuantity } = require('./availability');
const { applyMovement, isDuplicateKey } = require('./inventory.service');
const { transferMovementReference } = require('./movementReference');

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

/** Source and destination must differ. */
function assertDifferentLocations(sourceLocation, destinationLocation) {
    if (String(sourceLocation) === String(destinationLocation)) {
        throw sameLocationTransfer();
    }
}

// Status transition rule: target → its one legal predecessor.
const LEGAL_PREDECESSOR = {
    Dispatched: 'Requested',
    Received: 'Dispatched',
};

/**
 * Guard for transfer status transitions.
 * An already-Received transfer reports TRANSFER_ALREADY_RECEIVED rather than generic invalid.
 */
function assertTransferTransition(currentStatus, targetStatus) {
    if (targetStatus === 'Received' && currentStatus === 'Received') {
        throw transferAlreadyReceived();
    }
    if (LEGAL_PREDECESSOR[targetStatus] !== currentStatus) {
        throw invalidStatusTransition();
    }
}

/** Shared SELECT for populated transfer reads. */
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

/** Reads one transfer in the populated response shape, or null. */
async function findTransferById(id) {
    const rows = await query(`${TRANSFER_SELECT} WHERE t.id = ?`, [id]);
    return rows.length > 0 ? toInternalTransfer(rows[0]) : null;
}

/** Lists transfers, optionally filtered by status. */
async function listTransfers({ status } = {}) {
    const where = status ? ' WHERE t.status = ?' : '';
    const params = status ? [status] : [];
    const rows = await query(
        `${TRANSFER_SELECT}${where} ORDER BY t.created_at DESC, t.id`,
        params
    );
    return rows.map(toInternalTransfer);
}

/** Creates an Internal_Transfer in Requested status. No inventory write happens here. */
async function createTransfer({
    item,
    batch,
    sourceLocation,
    destinationLocation,
    quantity,
    createdBy = null,
}) {
    assertDifferentLocations(sourceLocation, destinationLocation);

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
    // A batch that doesn't exist at the source is an invalid reference, not an availability issue.
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

/** Dispatches a transfer: reduces source physical quantity and advances status to Dispatched. */
async function dispatchTransfer(transferId) {
    await withTransaction(async (tx) => {
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

/** Receives a transfer: increases destination physical quantity (creating the record if needed). */
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
                // Created at 0 then moved by applyMovement, keeping every unit traceable to a ledger row.
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
                if (!isDuplicateKey(error)) {
                    throw error;
                }
                // Concurrent receipt created it first — re-read rather than failing.
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
    assertDifferentLocations,
    assertTransferTransition,
    listTransfers,
    findTransferById,
    createTransfer,
    dispatchTransfer,
    receiveTransfer,
    TRANSFER_SELECT,
};

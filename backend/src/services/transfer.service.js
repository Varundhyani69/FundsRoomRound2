// backend/src/services/transfer.service.js -- the Transfer_Service: creates Internal_Transfers
// and advances them through Requested -> Dispatched -> Received, so in-transit stock is never
// counted at both the Source_Location and the Destination_Location at once (Req 6.1, 6.3, 6.6).
//
// `createTransfer` is a single-document insert with no ledger row, the same reasoning
// workOrder.service.js's createWorkOrder uses: nothing moves until dispatch (Req 6.1, 6.3).
//
// `dispatchTransfer` and `receiveTransfer` each run inside one `withTransaction` call and
// reuse `inventory.service.js`'s `applyMovement` for the one write that changes an
// Inventory_Record together with its ledger row (Req 4.4, 6.4, 6.7, 8.1). Neither guard nor
// status comparison is inlined outside the two named functions below (Req 15.5):
//   - assertDifferentLocations: Source_Location must differ from Destination_Location (Req 6.2)
//   - assertTransferTransition: the one legal path Requested -> Dispatched -> Received, with
//     the Req 6.9 carve-out that a receipt against an already-`Received` transfer is
//     `TRANSFER_ALREADY_RECEIVED`, not the generic `INVALID_STATUS_TRANSITION` (Req 6.10)
//
// Dispatch does not lean on `applyMovement`'s own guard-selection to pick an error code.
// `applyMovement` checks `assertSufficientPhysical` before `assertSufficientAvailable`, so a
// dispatch quantity that exceeds both physical and available would otherwise be reported as
// `INSUFFICIENT_PHYSICAL_QUANTITY`. Req 6.5 is explicit that a dispatch exceeding
// Available_Quantity is always `INSUFFICIENT_AVAILABLE_QUANTITY`, including when no source
// record exists at all, so `dispatchTransfer` reads the source record first and asks
// `availability.js` -- the single source of truth (Req 15.1) -- before ever calling
// `applyMovement`.

const mongoose = require('mongoose');

const InternalTransfer = require('../models/InternalTransfer');
const InventoryRecord = require('../models/InventoryRecord');
const Item = require('../models/Item');
const Location = require('../models/Location');
const { withTransaction } = require('../db/withTransaction');
const { applyMovement } = require('./inventory.service');
const { availableQuantity } = require('./availability');
const { transferMovementReference } = require('./movementReference');
const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

// Built fresh per call, the same way inventory.service.js's and workOrder.service.js's error
// factories are, so each thrown error carries its own stack.
const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'The referenced item, location, or source batch does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'Internal transfer not found.');

const sameLocationTransfer = () =>
    new AppError(
        ERROR_CODES.SAME_LOCATION_TRANSFER,
        'SAME_LOCATION_TRANSFER',
        'The destination location must differ from the source location.'
    );

const invalidStatusTransition = () =>
    new AppError(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        'INVALID_STATUS_TRANSITION',
        'This transfer is not in the status this action requires.'
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
        'This transfer quantity exceeds the available quantity at the source location.'
    );

/**
 * The named guard for Req 6.2: a transfer must move stock between two different locations.
 * Compared as strings after normalizing, since callers may pass either an ObjectId or the
 * string form of one.
 *
 * @param {string|import('mongoose').Types.ObjectId} sourceLocation
 * @param {string|import('mongoose').Types.ObjectId} destinationLocation
 * @throws {AppError} 400 SAME_LOCATION_TRANSFER when the two locations are equal
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
 * legal (Req 6.10): `targetStatus` must be the immediate successor of `currentStatus` in the
 * order `Requested` -> `Dispatched` -> `Received`.
 *
 * The one carve-out is Req 6.9: a receipt (`targetStatus === 'Received'`) against a transfer
 * that already holds Transfer_Status `Received` is reported as the business-meaningful
 * `TRANSFER_ALREADY_RECEIVED` rather than the generic `INVALID_STATUS_TRANSITION`, which is
 * what makes a second, concurrent, or replayed receipt request idempotent-looking to the
 * caller instead of merely "invalid" (Req 6.9, 6.16). Every other illegal pairing --
 * dispatching a `Dispatched` or `Received` transfer, or receiving a `Requested` one -- falls
 * through to `INVALID_STATUS_TRANSITION`.
 *
 * @param {'Requested'|'Dispatched'|'Received'} currentStatus
 * @param {'Dispatched'|'Received'} targetStatus
 * @throws {AppError} 409 TRANSFER_ALREADY_RECEIVED for the Req 6.9 carve-out; 409
 *   INVALID_STATUS_TRANSITION for every other non-successor pairing
 */
function assertTransferTransition(currentStatus, targetStatus) {
    if (targetStatus === 'Received' && currentStatus === 'Received') {
        throw transferAlreadyReceived();
    }
    if (LEGAL_PREDECESSOR[targetStatus] !== currentStatus) {
        throw invalidStatusTransition();
    }
}

/**
 * Populates an InternalTransfer document the same way for create, dispatch, receive, and
 * list, so the response shape never drifts between endpoints.
 *
 * @param {import('mongoose').Query} query
 * @returns {import('mongoose').Query}
 */
function populateTransfer(query) {
    return query
        .populate({ path: 'item', populate: { path: 'category' } })
        .populate('sourceLocation')
        .populate('destinationLocation');
}

/**
 * Creates an Internal_Transfer with Transfer_Status `Requested` (Req 6.1). No inventory
 * write happens here: Physical_Quantity only moves on dispatch and receipt (Req 6.3).
 *
 * @param {{ item: string, batch: string, sourceLocation: string, destinationLocation: string, quantity: number, createdBy?: string|null }} input
 *   `createdBy` is accepted for the same shape every other service's create function takes,
 *   but is not persisted: unlike WorkOrder or InventoryTransaction, InternalTransfer carries
 *   no `createdBy` field (see models/InternalTransfer.js and design.md's schema for it).
 * @returns {Promise<import('mongoose').Document>} the created, populated InternalTransfer
 * @throws {AppError} 400 SAME_LOCATION_TRANSFER when destination equals source; 400
 *   INVALID_REFERENCE when item, source location, destination location, or the source batch's
 *   Inventory_Record does not exist
 */
async function createTransfer({ item, batch, sourceLocation, destinationLocation, quantity }) {
    // Checked first, before any existence lookups, per the task's guard ordering.
    assertDifferentLocations(sourceLocation, destinationLocation);

    // Trimmed to match how InventoryRecord.batch is stored and compared (Req 3.1, 3.6), so a
    // batch differing only by surrounding whitespace still finds the source record.
    const trimmedBatch = typeof batch === 'string' ? batch.trim() : batch;

    const [itemExists, sourceLocationExists, destinationLocationExists] = await Promise.all([
        Item.exists({ _id: item }),
        Location.exists({ _id: sourceLocation }),
        Location.exists({ _id: destinationLocation }),
    ]);
    if (!itemExists || !sourceLocationExists || !destinationLocationExists) {
        throw invalidReference();
    }

    // A batch that does not exist at the source is an invalid reference, not an availability
    // problem: there is nothing to dispatch regardless of quantity (Req 6.14).
    const sourceRecordExists = await InventoryRecord.exists({
        item,
        location: sourceLocation,
        batch: trimmedBatch,
    });
    if (!sourceRecordExists) {
        throw invalidReference();
    }

    const created = await InternalTransfer.create({
        item,
        batch,
        sourceLocation,
        destinationLocation,
        quantity,
        status: 'Requested',
        receivedQuantity: 0,
    });

    return populateTransfer(InternalTransfer.findById(created._id));
}

/**
 * Dispatches an Internal_Transfer: reduces the source Inventory_Record's Physical_Quantity by
 * the transfer Quantity, writes one ledger row, and advances Transfer_Status to `Dispatched`
 * (Req 6.4).
 *
 * The Available_Quantity check happens here, against a fresh read of the source record taken
 * inside this transaction, before `applyMovement` is ever called -- not by letting
 * `applyMovement`'s generic physical/available guard selection decide the error code, which
 * would report `INSUFFICIENT_PHYSICAL_QUANTITY` for a quantity that exceeds both physical and
 * available. Req 6.5 requires `INSUFFICIENT_AVAILABLE_QUANTITY` specifically, including when
 * no source record exists at all (Available_Quantity is then 0).
 *
 * @param {string} transferId
 * @returns {Promise<import('mongoose').Document>} the updated InternalTransfer
 * @throws {AppError} 404 NOT_FOUND when no transfer matches `transferId`; 409
 *   INVALID_STATUS_TRANSITION when the transfer is not `Requested`; 409
 *   INSUFFICIENT_AVAILABLE_QUANTITY when the quantity exceeds the source's Available_Quantity
 */
async function dispatchTransfer(transferId) {
    return withTransaction(async (session) => {
        const transfer = await InternalTransfer.findById(transferId).session(session);
        if (!transfer) {
            throw notFound();
        }

        assertTransferTransition(transfer.status, 'Dispatched');

        const sourceRecord = await InventoryRecord.findOne({
            item: transfer.item,
            location: transfer.sourceLocation,
            batch: transfer.batch,
        }).session(session);

        // No source record at all means Available_Quantity is 0 (Req 6.5's explicit clause).
        const available = sourceRecord ? availableQuantity(sourceRecord) : 0;
        if (transfer.quantity > available) {
            throw insufficientAvailableQuantity();
        }

        await applyMovement(
            { item: transfer.item, location: transfer.sourceLocation, batch: transfer.batch },
            {
                physicalDelta: -transfer.quantity,
                reservedDelta: 0,
                movementReference: transferMovementReference(transfer._id, 'DISPATCH'),
            },
            session
        );

        transfer.status = 'Dispatched';
        transfer.dispatchedAt = new Date();
        await transfer.save({ session });

        return transfer;
    }).then((transfer) => populateTransfer(InternalTransfer.findById(transfer._id)));
}

/**
 * Receives an Internal_Transfer: increases the destination Inventory_Record's
 * Physical_Quantity by the transfer Quantity -- creating that record first if it does not yet
 * exist -- writes one ledger row, sets Received_Quantity, and advances Transfer_Status to
 * `Received` (Req 6.7, 6.8).
 *
 * The destination record is found or created inside this same transaction rather than
 * through `inventory.service.js`'s `createInventoryRecord`, which opens its own transaction:
 * Req 6.8 requires the creation to happen inside the same Transaction as the receipt.
 *
 * Idempotence (Req 6.9, 6.12, 6.16): a receipt against a transfer already `Received` is
 * rejected by `assertTransferTransition`'s carve-out before any write. If two receipts for
 * the same transfer race past that check (both reading Transfer_Status `Dispatched` before
 * either commits), the unique index on `movementReference` makes at most one of the two
 * `RECEIPT` ledger rows succeed; the loser's `applyMovement` call fails with
 * `DUPLICATE_INVENTORY_TRANSACTION`, which is remapped to `TRANSFER_ALREADY_RECEIVED` here
 * because that is the business-meaningful code for this path (design.md's movement reference
 * table).
 *
 * @param {string} transferId
 * @returns {Promise<import('mongoose').Document>} the updated InternalTransfer
 * @throws {AppError} 404 NOT_FOUND when no transfer matches `transferId`; 409
 *   TRANSFER_ALREADY_RECEIVED when the transfer already holds Transfer_Status `Received`, or
 *   when a concurrent receipt commits first; 409 INVALID_STATUS_TRANSITION when the transfer
 *   is not `Dispatched`
 */
async function receiveTransfer(transferId) {
    const received = await withTransaction(async (session) => {
        const transfer = await InternalTransfer.findById(transferId).session(session);
        if (!transfer) {
            throw notFound();
        }

        assertTransferTransition(transfer.status, 'Received');

        let destinationRecordId;
        const existingDestinationRecord = await InventoryRecord.findOne({
            item: transfer.item,
            location: transfer.destinationLocation,
            batch: transfer.batch,
        }).session(session);

        if (existingDestinationRecord) {
            destinationRecordId = existingDestinationRecord._id;
        } else {
            // Generated before the insert so the record and the receipt ledger row that
            // follows both name a known id inside this one transaction (Req 6.8, matching
            // the pattern createInventoryRecord uses for the opening ledger row, Req 4.9).
            const newRecordId = new mongoose.Types.ObjectId();
            try {
                await InventoryRecord.create(
                    [
                        {
                            _id: newRecordId,
                            item: transfer.item,
                            location: transfer.destinationLocation,
                            batch: transfer.batch,
                            physicalQuantity: 0,
                            reservedQuantity: 0,
                        },
                    ],
                    { session }
                );
                destinationRecordId = newRecordId;
            } catch (error) {
                // Only a concurrent receipt of this same transfer can race to create this
                // exact { item, destinationLocation, batch } record; re-reading it lets the
                // applyMovement call below decide the outcome through the movementReference
                // unique index, same as the ledger-row race this function's doc comment
                // describes.
                if (error.code !== 11000) {
                    throw error;
                }
                const raceWinnerRecord = await InventoryRecord.findOne({
                    item: transfer.item,
                    location: transfer.destinationLocation,
                    batch: transfer.batch,
                }).session(session);
                destinationRecordId = raceWinnerRecord._id;
            }
        }

        try {
            await applyMovement(
                { _id: destinationRecordId },
                {
                    physicalDelta: transfer.quantity,
                    reservedDelta: 0,
                    movementReference: transferMovementReference(transfer._id, 'RECEIPT'),
                },
                session
            );
        } catch (error) {
            if (error instanceof AppError && error.code === 'DUPLICATE_INVENTORY_TRANSACTION') {
                throw transferAlreadyReceived();
            }
            throw error;
        }

        transfer.receivedQuantity = transfer.quantity;
        transfer.status = 'Received';
        transfer.receivedAt = new Date();
        await transfer.save({ session });

        return transfer;
    });

    return populateTransfer(InternalTransfer.findById(received._id));
}

/**
 * Lists InternalTransfers, optionally filtered by Transfer_Status, populated with enough of
 * `item` (including its `category`), `sourceLocation`, and `destinationLocation` for the API
 * response shape (Req 3.2).
 *
 * @param {{ status?: string }} [filters]
 * @returns {Promise<import('mongoose').Document[]>}
 */
async function listTransfers({ status } = {}) {
    const filter = {};
    if (status) filter.status = status;

    return populateTransfer(InternalTransfer.find(filter));
}

module.exports = {
    assertDifferentLocations,
    assertTransferTransition,
    createTransfer,
    dispatchTransfer,
    receiveTransfer,
    listTransfers,
};

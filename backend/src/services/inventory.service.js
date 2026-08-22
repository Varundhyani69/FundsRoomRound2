// backend/src/services/inventory.service.js -- the Inventory_Service: creates Inventory_Records,
// adjusts them, reads them, and reads Location_Available_Quantity (Req 3.7, 3.8, 3.9, 3.10, 3.11,
// 3.12, 4.2, 4.3, 4.4, 4.6, 4.9, 8.1, 15.5).
//
// `applyMovement` is the one function in the whole codebase that writes an InventoryRecord
// change together with its InventoryTransaction ledger row (Req 4.4, 8.1). Every other
// service that moves stock -- work orders (read-only, no write here), transfers, orders --
// reuses it instead of restating the guard/ledger pattern.
//
// The two invariants of Req 3.8 are each a single named guard, not an inline comparison in a
// controller or in this module's callers (Req 15.5):
//   - assertSufficientPhysical: physicalQuantity must not go below 0 (Req 4.2)
//   - assertSufficientAvailable: reservedQuantity must not exceed physicalQuantity (Req 4.3)

const mongoose = require('mongoose');

const InventoryRecord = require('../models/InventoryRecord');
const InventoryTransaction = require('../models/InventoryTransaction');
const Item = require('../models/Item');
const Location = require('../models/Location');
const { withTransaction } = require('../db/withTransaction');
const { locationAvailableQuantity } = require('./availability');
const { openingMovementReference, adjustMovementReference } = require('./movementReference');
const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

// Built fresh per call, the same way auth.service.js and withTransaction.js build their
// AppError factories, so each thrown error carries its own stack.
const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'The referenced item or location does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'Inventory record not found.');

const duplicateInventoryRecord = () =>
    new AppError(
        ERROR_CODES.DUPLICATE_INVENTORY_RECORD,
        'DUPLICATE_INVENTORY_RECORD',
        'An inventory record for this item, location and batch already exists.'
    );

const duplicateInventoryTransaction = () =>
    new AppError(
        ERROR_CODES.DUPLICATE_INVENTORY_TRANSACTION,
        'DUPLICATE_INVENTORY_TRANSACTION',
        'This movement reference has already been applied.'
    );

const insufficientPhysicalQuantity = () =>
    new AppError(
        ERROR_CODES.INSUFFICIENT_PHYSICAL_QUANTITY,
        'INSUFFICIENT_PHYSICAL_QUANTITY',
        'This movement would set the physical quantity below 0.'
    );

const insufficientAvailableQuantity = () =>
    new AppError(
        ERROR_CODES.INSUFFICIENT_AVAILABLE_QUANTITY,
        'INSUFFICIENT_AVAILABLE_QUANTITY',
        'This movement would reserve more than is physically on hand.'
    );

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

/**
 * Normalizes what a caller may pass as the movement target into a Mongoose filter for
 * `InventoryRecord.findOne`. Accepts an existing record's `_id` (as a string, ObjectId, or a
 * document/plain object carrying one), or a `{ item, location, batch }` triple such as the
 * one `transfer.service.js` passes when it only knows the record's identity, not its id.
 *
 * @param {string|import('mongoose').Types.ObjectId|{ _id?: any, item?: any, location?: any, batch?: string }} recordFilterOrDoc
 * @returns {object} a Mongoose filter matching at most one InventoryRecord
 */
function toRecordFilter(recordFilterOrDoc) {
    if (
        typeof recordFilterOrDoc === 'string' ||
        recordFilterOrDoc instanceof mongoose.Types.ObjectId
    ) {
        return { _id: recordFilterOrDoc };
    }

    if (recordFilterOrDoc && recordFilterOrDoc._id) {
        return { _id: recordFilterOrDoc._id };
    }

    // Assumed to be an { item, location, batch } filter object.
    return recordFilterOrDoc;
}

/**
 * The single place that writes an InventoryRecord change together with its
 * InventoryTransaction ledger row, always inside the caller's session (Req 4.4, 8.1).
 *
 * The record is re-read inside the caller's transaction first, so the guard check below sees
 * the value the transaction actually holds (including any earlier write this same
 * transaction made to the record), then the write is a conditional update whose filter
 * repeats the same guard as a `$expr` -- the authoritative decision comes from the update's
 * match result, not from the earlier read (Req 7.4 pattern, reused here for every mutation).
 *
 * @param {string|import('mongoose').Types.ObjectId|object} recordFilterOrDoc the target record's `_id`, or an `{ item, location, batch }` filter
 * @param {{ physicalDelta: number, reservedDelta: number, movementReference: string, createdBy?: string|null }} movement
 * @param {import('mongoose').ClientSession} session the caller's transaction session
 * @returns {Promise<import('mongoose').Types.ObjectId>} the affected record's `_id`
 * @throws {AppError} 404 NOT_FOUND when no record matches; 409 INSUFFICIENT_PHYSICAL_QUANTITY,
 *   INSUFFICIENT_AVAILABLE_QUANTITY, or DUPLICATE_INVENTORY_TRANSACTION on a guard or ledger failure
 */
async function applyMovement(recordFilterOrDoc, movement, session) {
    const { physicalDelta, reservedDelta, movementReference, createdBy = null } = movement;

    const filter = toRecordFilter(recordFilterOrDoc);
    const current = await InventoryRecord.findOne(filter).session(session);
    if (!current) {
        throw notFound();
    }

    // The same two comparisons the JS guards make, expressed for the query filter so the
    // update only matches when the resulting state is legal (Req 3.8, 4.2, 4.3).
    const guardedFilter = {
        _id: current._id,
        $expr: {
            $and: [
                { $gte: [{ $add: ['$physicalQuantity', physicalDelta] }, 0] },
                {
                    $lte: [
                        { $add: ['$reservedQuantity', reservedDelta] },
                        { $add: ['$physicalQuantity', physicalDelta] },
                    ],
                },
            ],
        },
    };

    const updateResult = await InventoryRecord.updateOne(
        guardedFilter,
        { $inc: { physicalQuantity: physicalDelta, reservedQuantity: reservedDelta } },
        { session }
    );

    if (updateResult.matchedCount !== 1) {
        // The update's filter is what decided this, but the JS guards -- called here rather
        // than inlined -- pick the correct error code to report (Req 15.5).
        assertSufficientPhysical(current.physicalQuantity, physicalDelta);
        assertSufficientAvailable(
            current.physicalQuantity,
            current.reservedQuantity,
            physicalDelta,
            reservedDelta
        );
        // One of the two assertions above always throws when matchedCount !== 1, so this
        // line is unreachable; it exists only to fail loudly if that ever stops being true.
        throw insufficientAvailableQuantity();
    }

    try {
        await InventoryTransaction.create(
            [
                {
                    inventoryRecord: current._id,
                    physicalDelta,
                    reservedDelta,
                    movementReference,
                    appliedAt: new Date(),
                    createdBy,
                },
            ],
            { session }
        );
    } catch (error) {
        if (error.code === 11000) {
            throw duplicateInventoryTransaction();
        }
        throw error;
    }

    return current._id;
}

/**
 * Creates an InventoryRecord with an opening balance and its opening ledger row, both inside
 * one transaction (Req 3.10, 3.11, 4.9).
 *
 * @param {{ item: string, location: string, batch: string, physicalQuantity: number, createdBy?: string|null }} input
 * @returns {Promise<import('mongoose').Document>} the created, populated InventoryRecord
 * @throws {AppError} 400 INVALID_REFERENCE when item or location does not exist; 409
 *   DUPLICATE_INVENTORY_RECORD on an existing { item, location, batch } triple
 */
async function createInventoryRecord({ item, location, batch, physicalQuantity, createdBy = null }) {
    const [itemExists, locationExists] = await Promise.all([
        Item.exists({ _id: item }),
        Location.exists({ _id: location }),
    ]);
    if (!itemExists || !locationExists) {
        throw invalidReference();
    }

    const recordId = await withTransaction(async (session) => {
        // Generated before the insert so the opening ledger row can name this record's id
        // inside the same transaction that creates it (Req 4.9).
        const newRecordId = new mongoose.Types.ObjectId();

        try {
            await InventoryRecord.create(
                [
                    {
                        _id: newRecordId,
                        item,
                        location,
                        batch,
                        physicalQuantity: 0,
                        reservedQuantity: 0,
                    },
                ],
                { session }
            );
        } catch (error) {
            if (error.code === 11000) {
                throw duplicateInventoryRecord();
            }
            throw error;
        }

        // Routed through applyMovement rather than set on the insert above, so the opening
        // balance and its ledger row are written the same way every later movement is (Req
        // 4.4, 4.7, 4.9): the record starts at 0/0 and this is the first ledger-backed change.
        await applyMovement(
            { _id: newRecordId },
            {
                physicalDelta: physicalQuantity,
                reservedDelta: 0,
                movementReference: openingMovementReference(newRecordId),
                createdBy,
            },
            session
        );

        return newRecordId;
    });

    return InventoryRecord.findById(recordId)
        .populate({ path: 'item', populate: { path: 'category' } })
        .populate('location');
}

/**
 * Applies a manual IN/OUT adjustment to an existing InventoryRecord, writing one ledger row
 * for it (Req 4.2, 4.3, 4.6).
 *
 * @param {{ recordId: string, direction: 'IN'|'OUT', quantity: number, movementReference: string, createdBy?: string|null }} input
 * @returns {Promise<import('mongoose').Document>} the updated, populated InventoryRecord
 * @throws {AppError} 404 NOT_FOUND when no record matches `recordId`; 409
 *   INSUFFICIENT_PHYSICAL_QUANTITY, INSUFFICIENT_AVAILABLE_QUANTITY, or
 *   DUPLICATE_INVENTORY_TRANSACTION
 */
async function adjustInventoryRecord({ recordId, direction, quantity, movementReference: clientRef, createdBy = null }) {
    const updatedId = await withTransaction(async (session) => {
        const exists = await InventoryRecord.exists({ _id: recordId }).session(session);
        if (!exists) {
            throw notFound();
        }

        const physicalDelta = direction === 'IN' ? quantity : -quantity;

        return applyMovement(
            recordId,
            {
                physicalDelta,
                reservedDelta: 0,
                movementReference: adjustMovementReference(recordId, clientRef),
                createdBy,
            },
            session
        );
    });

    return InventoryRecord.findById(updatedId)
        .populate({ path: 'item', populate: { path: 'category' } })
        .populate('location');
}

/**
 * Lists InventoryRecords, optionally filtered by item and/or location, populated with enough
 * of `item` (including its `category`) and `location` for the API response shape (Req 3.2).
 *
 * @param {{ item?: string, location?: string }} [filters]
 * @returns {Promise<import('mongoose').Document[]>}
 */
async function listInventoryRecords({ item, location } = {}) {
    const filter = {};
    if (item) filter.item = item;
    if (location) filter.location = location;

    return InventoryRecord.find(filter)
        .populate({ path: 'item', populate: { path: 'category' } })
        .populate('location');
}

/**
 * Reads the Location_Available_Quantity of one item at one location, reporting 0 when no
 * InventoryRecord exists for that pair rather than NOT_FOUND (Req 3.12).
 *
 * @param {{ item: string, location: string }} input
 * @returns {Promise<{ item: string, location: string, locationAvailableQuantity: number }>}
 * @throws {AppError} 400 INVALID_REFERENCE when item or location does not exist
 */
async function getLocationAvailability({ item, location }) {
    const [itemExists, locationExists] = await Promise.all([
        Item.exists({ _id: item }),
        Location.exists({ _id: location }),
    ]);
    if (!itemExists || !locationExists) {
        throw invalidReference();
    }

    const records = await InventoryRecord.find({ item, location });

    return {
        item,
        location,
        locationAvailableQuantity: locationAvailableQuantity(records),
    };
}

module.exports = {
    applyMovement,
    assertSufficientPhysical,
    assertSufficientAvailable,
    createInventoryRecord,
    adjustInventoryRecord,
    listInventoryRecords,
    getLocationAvailability,
};

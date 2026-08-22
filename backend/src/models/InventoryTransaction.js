// backend/src/models/InventoryTransaction.js -- the append-only ledger: one document per
// applied change to one Inventory_Record, carrying the signed deltas, the Movement_Reference
// of the business action that caused it, and the time it was applied (Req 4.4).
//
// The deltas are signed on purpose. Summing every row that references one Inventory_Record
// must reproduce that record's `physicalQuantity` and `reservedQuantity`, opening row
// included, which is the ledger reconstruction property (Req 4.7).
//
// Nothing here writes a row. Rows are written by `applyMovement` in
// src/services/inventory.service.js, always inside the same transaction as the record
// change it describes, so a record can never move without its ledger row (Req 4.4, 8.1).

const mongoose = require('mongoose');

const inventoryTransactionSchema = new mongoose.Schema(
    {
        // The ObjectId of the Inventory_Record this row moved. The `InventoryRecord` model is
        // registered by src/models/InventoryRecord.js; Mongoose resolves the ref by name at
        // populate time, so the load order of the two files is free.
        inventoryRecord: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'InventoryRecord',
            required: true,
        },

        // Signed: negative for an outward movement, positive for an inward one, 0 for a
        // movement that only touched the other column (a reservation, for instance).
        // `Number.isInteger` because quantities are whole units, never fractions.
        physicalDelta: {
            type: Number,
            required: true,
            validate: {
                validator: Number.isInteger,
                message: 'physicalDelta must be an integer',
            },
        },

        // Signed, same reasoning as `physicalDelta`.
        reservedDelta: {
            type: Number,
            required: true,
            validate: {
                validator: Number.isInteger,
                message: 'reservedDelta must be an integer',
            },
        },

        // The identity of the business action. `unique: true` is the whole idempotency
        // mechanism: replaying an action produces the same reference, so the second write
        // fails with a duplicate-key error at commit time and the service maps that to
        // `DUPLICATE_INVENTORY_TRANSACTION` (Req 4.5, 4.6). No separate idempotency table.
        // Trimmed so the index compares exact values, the same way `batch` is trimmed.
        movementReference: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            minlength: 1,
            maxlength: 200,
        },

        // When the change was applied, which is what the ledger is ordered by. Distinct from
        // the `createdAt` that `timestamps` adds: `appliedAt` is the business time the
        // service states, `createdAt` is when the document happened to be inserted (Req 4.4).
        appliedAt: {
            type: Date,
            required: true,
            default: Date.now,
        },

        // The User who caused the movement, or null. Nullable because some rows come from the
        // seed script rather than from a request, so there is no caller to record.
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true }
);

// No explicit `index({ movementReference: 1 }, { unique: true })`: `unique: true` on the
// field above already declares that index, and declaring it twice makes Mongoose warn about
// a duplicate index.

// Non-unique, because one record has many rows. It exists so replaying the ledger of one
// record in applied order is an index scan rather than a collection scan (Req 4.7).
inventoryTransactionSchema.index({ inventoryRecord: 1, appliedAt: 1 });

// Append-only: a written row is corrected by appending another row, never by editing or
// removing the original (Req 4.10). These hooks make that a database-level fact instead of a
// convention someone can forget, so a stray `updateOne` anywhere fails loudly at the model.
const blockMutation = function (next) {
    next(new Error('InventoryTransaction documents are append-only'));
};

['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']
    .forEach((op) => inventoryTransactionSchema.pre(op, blockMutation));

module.exports = mongoose.model('InventoryTransaction', inventoryTransactionSchema);

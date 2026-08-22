// backend/src/models/InternalTransfer.js -- an in-transit move of one Batch of one Item from
// a Source_Location to a Destination_Location, tracked through Requested, Dispatched, and
// Received so stock in transit is never counted at both ends at once (Req 6.1).
//
// There is deliberately no inventory write on create: the Physical_Quantity at the source
// only drops on dispatch and the Physical_Quantity at the destination only rises on receipt,
// both applied by src/services/transfer.service.js inside a Transaction (Req 6.3, 6.6).

const mongoose = require('mongoose');

const { validQuantity } = require('./fields');

const internalTransferSchema = new mongoose.Schema(
    {
        // ObjectId references, not embedded copies, so renaming an Item or a Location is one
        // write and leaves no stale duplicates behind (Req 3.2). The `Item` and `Location`
        // models are registered by their own files; Mongoose resolves a ref by name at
        // populate time, so the load order of these files is free.
        item: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Item',
            required: true,
        },

        // Trimmed so a value like ' A1 ' matches the same Inventory_Record as 'A1' when the
        // service looks up the source record by Item, Source_Location, and Batch (Req 6.1).
        batch: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 32,
        },

        sourceLocation: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Location',
            required: true,
        },

        destinationLocation: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Location',
            required: true,
        },

        // Valid_Quantity: an integer from 1 to 1,000,000, shared with every other quantity
        // field that can never legitimately be zero (Req 6.13).
        quantity: validQuantity,

        // Starts at 0 and is set to `quantity` only when the Transfer_Status becomes
        // `Received` (Req 6.1, 6.7). The upper-bound validator reads `this.quantity` rather
        // than a fixed number, so a future partial-receipt feature can set any value up to
        // the transfer's own quantity by editing only the receipt guard, not this schema
        // (Req 15.2).
        receivedQuantity: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
            validate: [
                {
                    validator: Number.isInteger,
                    message: 'receivedQuantity must be an integer',
                },
                {
                    validator(value) {
                        return value <= this.quantity;
                    },
                    message: 'receivedQuantity cannot exceed quantity',
                },
            ],
        },

        // The three-step lifecycle an Internal_Transfer moves through, in order. Every
        // change to this field goes through `assertTransferTransition` in
        // transfer.service.js so an out-of-order or repeated transition is rejected in one
        // place (Req 6.10).
        status: {
            type: String,
            required: true,
            enum: ['Requested', 'Dispatched', 'Received'],
            default: 'Requested',
        },

        // Null until the dispatch step is accepted, so a freshly created transfer reports no
        // dispatch time (Req 6.4).
        dispatchedAt: {
            type: Date,
            default: null,
        },

        // Null until the receipt step is accepted, so a dispatched-but-not-yet-received
        // transfer reports no receipt time (Req 6.7).
        receivedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

// Non-unique: it exists so listing Internal_Transfers by status is an index scan rather than
// a collection scan.
internalTransferSchema.index({ status: 1 });

// Non-unique: it exists so the dispatch step's lookup of the source Inventory_Record by Item,
// Source_Location, and Batch -- and any list filtered the same way -- is an index scan rather
// than a collection scan. Unlike InventoryRecord's key, this combination does not identify a
// unique Internal_Transfer: more than one transfer can request the same Item, source, and
// Batch over time.
internalTransferSchema.index({ item: 1, sourceLocation: 1, batch: 1 });

module.exports = mongoose.model('InternalTransfer', internalTransferSchema);

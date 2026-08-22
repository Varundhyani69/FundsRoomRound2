// backend/src/models/InventoryRecord.js -- the stock balance of one Item, at one Location,
// in one Batch: a Physical_Quantity and a Reserved_Quantity and nothing else (Req 3.1).
//
// There is deliberately no stored available quantity. Available_Quantity is derived at read
// time from the two stored counts by `availableQuantity(record)` in
// src/services/availability.js, so the two can never disagree (Req 3.3, 3.4).

const mongoose = require('mongoose');

const { nonNegativeCount } = require('./fields');

const inventoryRecordSchema = new mongoose.Schema(
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

        location: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Location',
            required: true,
        },

        // Trimmed by the schema so the unique index below compares exact trimmed values and
        // ' A1 ' cannot become a second record beside 'A1' (Req 3.1, 3.6).
        batch: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 32,
        },

        // Both default to 0, so a record created with only a Physical_Quantity starts
        // unreserved (Req 3.10).
        physicalQuantity: nonNegativeCount,
        reservedQuantity: nonNegativeCount,
    },
    { timestamps: true }
);

// The uniqueness rule of the whole inventory model: one record per Item, Location and Batch
// (Req 3.6, 3.7). It is declared once. The same key pattern also serves the list and
// availability reads and the ascending-batch reservation scan, so no second non-unique index
// on `{ item, location, batch }` is needed -- a duplicate declaration would only make
// Mongoose warn (Req 3.5).
inventoryRecordSchema.index({ item: 1, location: 1, batch: 1 }, { unique: true });

// The derived Available_Quantity, exposed as a virtual so a serialized record carries the
// same number a service computes (Req 3.3). The require sits inside the getter because
// src/services/availability.js is the module that owns the subtraction (Req 15.1) and
// requiring it at the top of a model file would create a model -> service load-time
// dependency; a lazy require keeps the direction one-way.
inventoryRecordSchema.virtual('availableQuantity').get(function () {
    const { availableQuantity } = require('../services/availability');
    return availableQuantity(this);
});

module.exports = mongoose.model('InventoryRecord', inventoryRecordSchema);

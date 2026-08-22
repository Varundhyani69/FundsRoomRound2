// backend/src/models/CustomerOrder.js -- a Sales_User's promise of a Valid_Quantity of one
// Item at one Location to a customer, reserved out of Inventory_Record Available_Quantity so
// the same units can never be promised twice (Req 7.1).
//
// The `reservations` list is the batch-level breakdown of exactly which Inventory_Record
// documents were consumed to cover the order's Quantity. It is embedded rather than stored as
// a separate collection or as references back to Inventory_Transaction rows, because
// cancelling a Customer_Order needs to release exactly the Reserved_Quantity each entry took --
// no join, no ledger scan, just the entries already sitting on the order itself (Req 15.3).

const mongoose = require('mongoose');

const { validQuantity } = require('./fields');

// One line of the reservation breakdown: how much of one Batch of one Item at one Location
// this order consumed. `_id: false` because an entry is never addressed on its own -- it is
// only ever read or summed as part of its parent Customer_Order's `reservations` array
// (Req 15.3).
const reservationEntrySchema = new mongoose.Schema(
    {
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

        // Trimmed so a value like ' A1 ' matches the same Inventory_Record as 'A1' when a
        // future cancellation guard looks up the record this entry drew from (Req 6.1 style
        // consistency, Req 15.3).
        batch: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 32,
        },

        // Valid_Quantity: an integer from 1 to 1,000,000, shared with every other quantity
        // field that can never legitimately be zero (Req 15.6 -- every entry Quantity is
        // greater than 0).
        quantity: validQuantity,
    },
    { _id: false }
);

const customerOrderSchema = new mongoose.Schema(
    {
        // Trimmed, 1..120 characters (Req 7.11). Free text rather than a reference because no
        // Customer collection exists in this design; the design only needs a name to display.
        customerName: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 120,
        },

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

        // The total Quantity promised to the customer. This is the number the Order_Service
        // checks against Location_Available_Quantity before reserving anything; the
        // per-batch breakdown that actually satisfies it lives in `reservations` below
        // (Req 7.1, 7.2).
        quantity: validQuantity,

        // Only two states: a Customer_Order either holds its reservation or has been
        // cancelled. There is no in-between step like Internal_Transfer's Dispatched, because
        // reservation happens atomically at creation (Req 7.1).
        status: {
            type: String,
            required: true,
            enum: ['Reserved', 'Cancelled'],
            default: 'Reserved',
        },

        // The batch-level breakdown of this order's reservation, one entry per
        // Inventory_Record the Order_Service changed while covering `quantity`. Bounded to
        // 1..20 entries because a single order that had to be split across more than 20
        // batches would signal a data problem worth surfacing rather than silently accepting
        // (Req 15.3).
        reservations: {
            type: [reservationEntrySchema],
            required: true,
            validate: {
                validator: (entries) => entries.length >= 1 && entries.length <= 20,
                message: 'reservations must hold between 1 and 20 entries',
            },
        },

        // The User who created this Customer_Order. Required, like `WorkOrder`'s `createdBy`,
        // because every Customer_Order is created through an authenticated Sales_User
        // request.
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
    },
    { timestamps: true }
);

// Non-unique: it exists so reading the Customer_Orders of one Item at one Location -- the
// pair the reservation totals are read against -- is an index scan rather than a collection
// scan.
customerOrderSchema.index({ item: 1, location: 1 });

// Non-unique: it exists so listing Customer_Orders by status is an index scan rather than a
// collection scan.
customerOrderSchema.index({ status: 1 });

module.exports = mongoose.model('CustomerOrder', customerOrderSchema);

// backend/src/models/WorkOrder.js -- an instruction for an Assigned_User to consume a
// Required_Quantity of one Item at one Location (Req 5.1).
//
// There is deliberately no stored shortage field. Shortage_Quantity is derived at read time
// as `max(0, requiredQuantity - locationAvailableQuantity)` by src/services/workOrder.service.js
// using `locationAvailableQuantity` from src/services/availability.js, so a shortage can
// never disagree with the current inventory (Req 5.4).

const mongoose = require('mongoose');

const { validQuantity } = require('./fields');

const workOrderSchema = new mongoose.Schema(
    {
        // ObjectId references, not embedded copies, so renaming a Location or an Item is one
        // write and leaves no stale duplicates behind (Req 3.2). The `Location` and `Item`
        // models are registered by their own files; Mongoose resolves a ref by name at
        // populate time, so the load order of these files is free.
        location: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Location',
            required: true,
        },

        item: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Item',
            required: true,
        },

        // Valid_Quantity: an integer from 1 to 1,000,000, shared with every other quantity
        // field that can never legitimately be zero (Req 5.2).
        requiredQuantity: validQuantity,

        // The User responsible for performing the work. Required because a Work_Order with
        // nobody assigned has nobody to notify.
        assignedUser: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },

        // The three-step lifecycle a Work_Order moves through, in order. Every change to
        // this field goes through `nextWorkOrderStatus` in workOrder.service.js so an
        // out-of-order or repeated transition is rejected in one place (Req 5.8, 5.9).
        status: {
            type: String,
            required: true,
            enum: ['Assigned', 'InProgress', 'Completed'],
            default: 'Assigned',
        },

        // The time of the most recently accepted status change. Null until the first
        // accepted transition, so a freshly created Work_Order reports no change time
        // (Req 5.7).
        statusChangedAt: {
            type: Date,
            default: null,
        },

        // The User who created this Work_Order. Required, unlike `InventoryTransaction`'s
        // nullable `createdBy`, because every Work_Order is created through an authenticated
        // Admin request rather than the seed script alone.
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
    },
    { timestamps: true }
);

// Non-unique: it exists so reading the Work_Orders of one Item at one Location -- the pair
// the shortage calculation reads inventory for -- is an index scan rather than a collection
// scan.
workOrderSchema.index({ item: 1, location: 1 });

// Non-unique: it exists so listing Work_Orders by status is an index scan rather than a
// collection scan.
workOrderSchema.index({ status: 1 });

module.exports = mongoose.model('WorkOrder', workOrderSchema);

// backend/src/models/Location.js -- the Location document: a physical company site that
// holds inventory and that Inventory_Records and Users point at by ObjectId reference
// (Req 3.2, 15.4).

const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema(
    {
        // The Location code is the business identity, so it is unique and trimmed. Two
        // sites may share a `name`, which is why only `code` carries `unique: true`.
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            minlength: 1,
            maxlength: 32,
        },

        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 1,
            maxlength: 120,
        },
    },
    { timestamps: true }
);

// No explicit `locationSchema.index({ code: 1 })`: `unique: true` above already declares
// that index, and declaring it twice makes Mongoose warn about a duplicate index.

module.exports = mongoose.model('Location', locationSchema);

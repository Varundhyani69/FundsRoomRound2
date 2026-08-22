// backend/src/models/Category.js -- the Category document: a classification grouping that
// Item documents point at by ObjectId reference (Req 3.2).

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
    {
        // Trimmed so ' Raw Material ' and 'Raw Material' cannot both be stored as
        // distinct categories; `unique: true` then rejects the second one.
        name: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            minlength: 1,
            maxlength: 64,
        },
    },
    { timestamps: true }
);

// No explicit `categorySchema.index({ name: 1 })`: `unique: true` above already declares
// that index, and declaring it twice makes Mongoose warn about a duplicate index.

module.exports = mongoose.model('Category', categorySchema);

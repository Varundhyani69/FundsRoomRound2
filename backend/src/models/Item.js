// backend/src/models/Item.js -- the Item document: a stock-keeping product definition
// identified by its code and belonging to exactly one Category (Req 3.2).

const mongoose = require('mongoose');

// Required so the Category schema is registered with Mongoose before anything calls
// `.populate('category')` on an Item (or on an Item nested under another populate, as
// inventory/work-order/transfer/order services all do). Mongoose only needs the ref by
// name at populate time, but that name still has to resolve to a model that some module
// has actually required at least once; nothing else in the server's normal request path
// requires Category.js directly, so without this line the very first request that
// populates a Category (any record that actually has data) throws MissingSchemaError.
require('./Category');

const itemSchema = new mongoose.Schema(
    {
        // The Item code is the business identity, so it is unique and trimmed. Two Items
        // may share a `name`, which is why only `code` carries `unique: true`.
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

        // The ObjectId of an existing Category, not an embedded copy of it, so renaming a
        // Category is one write and never leaves stale duplicates behind (Req 3.2). The
        // `Category` model is registered by src/models/Category.js; Mongoose resolves the
        // ref by name at populate time, so the load order of the two files is free.
        category: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Category',
            required: true,
        },
    },
    { timestamps: true }
);

// Non-unique, because many Items share a Category. It exists so listing the Items of one
// Category is an index scan rather than a collection scan. The `{ code: 1 }` unique index
// is not repeated here: `unique: true` above already declares it.
itemSchema.index({ category: 1 });

module.exports = mongoose.model('Item', itemSchema);

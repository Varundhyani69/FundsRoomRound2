// backend/src/models/fields.js -- the two quantity field definitions every schema in the
// inventory model reuses, so the bounds of a count live in one place (Req 3.1).
//
// These are plain option objects handed to Mongoose as a schema path definition, e.g.
// `physicalQuantity: nonNegativeCount`. Mongoose only reads them, so sharing one object
// across several paths and schemas is safe; nothing here is mutated at run time.

// A stored count that may legitimately be zero: Physical_Quantity and Reserved_Quantity.
// The integer validator matters because `min`/`max` alone accept 12.5 (Req 3.1).
const nonNegativeCount = {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    max: 999_999_999,
    validate: { validator: Number.isInteger, message: '{PATH} must be an integer' },
};

// Valid_Quantity: the size of a requested movement, which is never zero or negative.
// Used by the Work_Order, Internal_Transfer and Customer_Order schemas.
const validQuantity = {
    type: Number,
    required: true,
    min: 1,
    max: 1_000_000,
    validate: { validator: Number.isInteger, message: '{PATH} must be an integer' },
};

module.exports = { nonNegativeCount, validQuantity };

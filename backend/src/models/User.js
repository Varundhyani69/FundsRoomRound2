// backend/src/models/User.js -- the User document: one email, one bcrypt hash, one Role,
// and an optional Assigned_Location (Req 1.1, 1.5, 15.4).
//
// The schema stores no plaintext password and performs no hashing. Hashing lives in
// `hashPassword` in src/services/auth.service.js, which is the single place that turns a
// plaintext password into the `passwordHash` value persisted here (Req 1.5).

const mongoose = require('mongoose');

const ROLES = ['Admin', 'OperationsUser', 'SalesUser'];

const userSchema = new mongoose.Schema(
    {
        // Lowercased and trimmed by the schema, so the login lookup compares the same
        // normalized form the document was stored under (Req 1.1, 1.2).
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            maxlength: 254,
        },

        // `select: false` keeps the hash out of every query result unless a caller
        // explicitly asks for it with `.select('+passwordHash')`, which only the login
        // lookup does. A list response therefore cannot leak it (Req 1.1).
        passwordHash: {
            type: String,
            required: true,
            select: false,
        },

        // Exactly one Role per User.
        role: {
            type: String,
            required: true,
            enum: ROLES,
        },

        // Either the ObjectId of an existing Location or null. Nullable because an Admin
        // is not tied to a site; restricting a User to this Location later means adding one
        // filter in the authorize middleware, not changing this schema (Req 15.4).
        // The `Location` model is registered by src/models/Location.js; Mongoose resolves
        // the ref by name at populate time, so the load order of the two files is free.
        assignedLocation: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Location',
            default: null,
        },
    },
    { timestamps: true }
);

// No explicit `userSchema.index({ email: 1 })`: `unique: true` above already declares
// that index, and declaring it twice makes Mongoose warn about a duplicate index.

module.exports = mongoose.model('User', userSchema);

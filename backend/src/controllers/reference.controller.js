// backend/src/controllers/reference.controller.js
// The three read-only reference lists the Web_Client needs to fill its form
// dropdowns: Items with their Category, Locations, and Users (Req 3.2).
//
// These handlers read their models directly, and that is deliberate: the
// responsibility table in design.md keeps model access out of controllers because
// controllers must not hold business rules, and the design lists no
// reference.service.js. There is no rule to hold here -- no quantity comparison,
// no status transition, no transaction -- only "list the documents and shape
// them". A service layer whose every function were `Model.find()` would add a file
// without adding a decision. Anything that grows a guard moves to a service.
//
// Each list is sorted by the field a person would scan the dropdown by, so the
// order the client renders is stable across calls rather than insertion order.

const Item = require('../models/Item');
const Location = require('../models/Location');
const User = require('../models/User');

/**
 * GET /api/items
 * 200 [{ id, code, name, category: { id, name } }]
 * 401 UNAUTHENTICATED (raised by authenticate before this runs, Req 1.8)
 */
async function listItems(req, res, next) {
    try {
        // The Category is stored as an ObjectId reference, never as an embedded copy
        // (Req 3.2), so the name the dropdown shows is populated at read time. Only
        // `name` is selected: the client needs the id to submit and the name to
        // display, nothing else.
        const items = await Item.find()
            .populate('category', 'name')
            .sort({ code: 1 })
            .lean();

        return res.status(200).json(items.map(toItemResponse));
    } catch (error) {
        // Express 4 does not observe a rejected promise, so the error is handed to
        // next() explicitly: errorHandler stays the only place that writes an error
        // response (Req 9.5).
        return next(error);
    }
}

/**
 * GET /api/locations
 * 200 [{ id, code, name }]
 * 401 UNAUTHENTICATED
 */
async function listLocations(req, res, next) {
    try {
        const locations = await Location.find().sort({ code: 1 }).lean();

        return res.status(200).json(
            locations.map((location) => ({
                id: String(location._id),
                code: location.code,
                name: location.name,
            }))
        );
    } catch (error) {
        return next(error);
    }
}

/**
 * GET /api/users
 * 200 [{ id, email, role }]
 * 401 UNAUTHENTICATED
 *
 * This is the list a Work_Order form assigns from, so it exposes exactly the three
 * fields that form needs. `passwordHash` carries `select: false` in the schema, so
 * it is already absent; the explicit `.select()` says so at the call site too, and
 * means a field added to the User schema later cannot appear in this response by
 * accident (Req 1.1).
 */
async function listUsers(req, res, next) {
    try {
        const users = await User.find().select('email role').sort({ email: 1 }).lean();

        return res.status(200).json(
            users.map((user) => ({
                id: String(user._id),
                email: user.email,
                role: user.role,
            }))
        );
    } catch (error) {
        return next(error);
    }
}

/**
 * One lean Item document becomes one response entry. `category` is null only if the
 * referenced Category no longer exists, in which case populate() leaves the field
 * empty; the list still renders rather than throwing on a missing name.
 */
function toItemResponse(item) {
    return {
        id: String(item._id),
        code: item.code,
        name: item.name,
        category: item.category
            ? { id: String(item.category._id), name: item.category.name }
            : null,
    };
}

module.exports = { listItems, listLocations, listUsers };

// backend/src/controllers/reference.controller.js
// The three read-only reference lists the Web_Client needs to fill its form dropdowns: Items
// with their Category, Locations, and Users (Req 3.2).
//
// These handlers query directly rather than through a service, and that is deliberate: the
// responsibility split in design.md keeps data access out of controllers because controllers
// must not hold business rules, and there is no rule to hold here -- no quantity comparison,
// no status transition, no transaction. Only "list the rows and shape them". A service whose
// every function were a single SELECT would add a file without adding a decision. Anything
// that grows a guard moves to a service.
//
// Each list is sorted by the field a person would scan the dropdown by, so the order the
// client renders is stable across calls rather than whatever order the storage engine returns.

const { query } = require('../db/pool');
const { toUserRef } = require('../db/mappers');

/**
 * GET /api/items
 * 200 [{ id, code, name, category: { id, name } }]
 * 401 UNAUTHENTICATED (raised by authenticate before this runs, Req 1.8)
 */
async function listItems(req, res, next) {
    try {
        // The category name is JOINed rather than duplicated onto the item row, because the
        // category is a separate entity referenced by id (Req 3.2) -- so renaming a category
        // is one UPDATE and every item picks it up.
        const rows = await query(
            `SELECT i.id, i.code, i.name,
                    c.id AS category_id, c.name AS category_name
               FROM items i
               JOIN categories c ON c.id = i.category_id
              ORDER BY i.code`
        );

        return res.status(200).json(
            rows.map((row) => ({
                id: row.id,
                code: row.code,
                name: row.name,
                category: { id: row.category_id, name: row.category_name },
            }))
        );
    } catch (error) {
        // Express 4 does not observe a rejected promise, so the error is handed to next()
        // explicitly: errorHandler stays the only place that writes an error response
        // (Req 9.5).
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
        const rows = await query('SELECT id, code, name FROM locations ORDER BY code');
        return res.status(200).json(
            rows.map((row) => ({ id: row.id, code: row.code, name: row.name }))
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
 * This is the list a Work_Order form assigns from, so it selects exactly the three columns
 * that form needs. `password_hash` is named in one query in the whole codebase -- the login
 * lookup -- and listing the columns explicitly here rather than using `SELECT *` means a
 * column added to `users` later cannot appear in this response by accident (Req 1.1).
 */
async function listUsers(req, res, next) {
    try {
        const rows = await query('SELECT id, email, role FROM users ORDER BY email');
        return res.status(200).json(rows.map(toUserRef));
    } catch (error) {
        return next(error);
    }
}

module.exports = { listItems, listLocations, listUsers };

// Reference controller: read-only lists for items, locations, and users (form dropdowns).
// Queries directly — no service needed since there are no business rules here.

const { query } = require('../db/pool');
const { toUserRef } = require('../db/mappers');

/** GET /api/items */
async function listItems(req, res, next) {
    try {
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
        // Express 4 does not observe a rejected promise
        return next(error);
    }
}

/** GET /api/locations */
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

/** GET /api/users — selects only id, email, role (never password_hash). */
async function listUsers(req, res, next) {
    try {
        const rows = await query('SELECT id, email, role FROM users ORDER BY email');
        return res.status(200).json(rows.map(toUserRef));
    } catch (error) {
        return next(error);
    }
}

module.exports = { listItems, listLocations, listUsers };

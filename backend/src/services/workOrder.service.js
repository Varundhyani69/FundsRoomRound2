// backend/src/services/workOrder.service.js -- the Work_Order_Service: creates Work_Orders,
// reads them with a freshly derived Shortage_Quantity, and advances Work_Order_Status through
// one guarded transition function (Req 5.1, 5.3-5.10, 5.12, 15.5).
//
// There is no transaction here: creating a Work_Order is a single-row insert with no ledger
// row to write alongside it, unlike inventory.service.js's applyMovement (Req 5.1). The
// status change is a single conditional UPDATE, which is atomic on its own.
//
// Shortage_Quantity is never stored (there is no such column -- see src/db/schema.sql). It is
// computed fresh on every read from the inventory_records current at that read, via
// `locationAvailableQuantity` from availability.js, the single source of truth for
// availability (Req 5.4, 15.1).
//
// `nextWorkOrderStatus` is the one place the Assigned -> InProgress -> Completed rule lives
// (Req 5.8, 15.5). `changeStatus` is its only caller here, and no other module compares a
// Work_Order_Status inline.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { newId } = require('../db/id');
const { toWorkOrder } = require('../db/mappers');
const { locationAvailableQuantity } = require('./availability');

// Built fresh per call, the same way inventory.service.js's error factories are, so each
// thrown error carries its own stack.
const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'The referenced location, item, or assigned user does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'Work order not found.');

const invalidStatusTransition = () =>
    new AppError(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        'INVALID_STATUS_TRANSITION',
        'This status change is not the successor of the current status.'
    );

// The one Work_Order_Status transition rule, expressed as "current -> its one legal
// successor" (Req 5.8). Nothing is a legal successor of the terminal `Completed`, so it has
// no entry and every target requested from it fails the lookup below.
const LEGAL_SUCCESSOR = {
    Assigned: 'InProgress',
    InProgress: 'Completed',
};

/**
 * The named guard that decides whether a Work_Order_Status change is legal: only the
 * immediate successor in the order `Assigned` -> `InProgress` -> `Completed` is legal.
 * Same-status, backward, skip-ahead, and any transition away from the terminal `Completed`
 * are all illegal (Req 5.9). This is the one place that rule lives; `changeStatus` below is
 * its only caller (Req 5.8, 15.5).
 *
 * @param {string} currentStatus one of 'Assigned', 'InProgress', 'Completed'
 * @param {string} targetStatus one of 'Assigned', 'InProgress', 'Completed'
 * @returns {boolean} true only when `targetStatus` is the immediate successor
 */
function nextWorkOrderStatus(currentStatus, targetStatus) {
    return LEGAL_SUCCESSOR[currentStatus] === targetStatus;
}

// The JOIN every work order read shares, aliasing columns as `<relation>_<field>` so
// src/db/mappers.js can rebuild the nested response shape. Declared once so create, list and
// get cannot drift apart. `assigned_user_*` selects only email and role -- never
// password_hash (Req 1.1).
const WORK_ORDER_SELECT = `
    SELECT wo.id, wo.required_quantity, wo.status, wo.status_changed_at,
           wo.created_at, wo.updated_at,
           i.id AS item_id, i.code AS item_code, i.name AS item_name,
           c.id AS category_id, c.name AS category_name,
           l.id AS location_id, l.code AS location_code, l.name AS location_name,
           u.id AS assigned_user_id, u.email AS assigned_user_email, u.role AS assigned_user_role
      FROM work_orders wo
      JOIN items i      ON i.id = wo.item_id
      JOIN categories c ON c.id = i.category_id
      JOIN locations l  ON l.id = wo.location_id
      JOIN users u      ON u.id = wo.assigned_user_id`;

/**
 * Computes the Location_Available_Quantity and Shortage_Quantity of one Work_Order at read
 * time, treating availability as 0 when no inventory_records exist for that item and
 * location (Req 5.4, 5.5, 5.6, 5.10).
 *
 * The rows are summed in JS by `locationAvailableQuantity` rather than by SQL's SUM(), so the
 * availability rule keeps exactly one definition (Req 15.1).
 *
 * @param {{ item: { _id: string }, location: { _id: string }, requiredQuantity: number }} workOrder
 * @returns {Promise<{ locationAvailableQuantity: number, shortageQuantity: number }>}
 */
async function computeShortage(workOrder) {
    const rows = await query(
        `SELECT physical_quantity, reserved_quantity
           FROM inventory_records
          WHERE item_id = ? AND location_id = ?`,
        [workOrder.item._id, workOrder.location._id]
    );

    const available = locationAvailableQuantity(
        rows.map((row) => ({
            physicalQuantity: row.physical_quantity,
            reservedQuantity: row.reserved_quantity,
        }))
    );

    return {
        locationAvailableQuantity: available,
        // max(0, ...) so a surplus reports 0 rather than a negative shortage (Req 5.6).
        shortageQuantity: Math.max(0, workOrder.requiredQuantity - available),
    };
}

/** Reads one work order by id and attaches its derived shortage, or null when absent. */
async function findWorkOrderById(id) {
    const rows = await query(`${WORK_ORDER_SELECT} WHERE wo.id = ?`, [id]);
    if (rows.length === 0) {
        return null;
    }
    const workOrder = toWorkOrder(rows[0]);
    return Object.assign(workOrder, await computeShortage(workOrder));
}

/**
 * Creates a Work_Order with Work_Order_Status `Assigned` (Req 5.1).
 *
 * @param {{ location: string, item: string, requiredQuantity: number, assignedUser: string, createdBy?: string|null }} input
 * @returns {Promise<object>} the created work order in the populated response shape
 * @throws {AppError} 400 INVALID_REFERENCE when location, item, or assignedUser is absent
 */
async function createWorkOrder({ location, item, requiredQuantity, assignedUser, createdBy = null }) {
    // All three references are checked in one round trip so the caller gets
    // INVALID_REFERENCE (400) rather than a raw foreign key failure (Req 5.3).
    const refRows = await query(
        `SELECT
             (SELECT COUNT(*) FROM locations WHERE id = ?) AS locationCount,
             (SELECT COUNT(*) FROM items     WHERE id = ?) AS itemCount,
             (SELECT COUNT(*) FROM users     WHERE id = ?) AS userCount`,
        [location, item, assignedUser]
    );
    const { locationCount, itemCount, userCount } = refRows[0];
    if (locationCount !== 1 || itemCount !== 1 || userCount !== 1) {
        throw invalidReference();
    }

    const id = newId();
    await query(
        `INSERT INTO work_orders
             (id, location_id, item_id, required_quantity, assigned_user_id, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'Assigned', ?)`,
        [id, location, item, requiredQuantity, assignedUser, createdBy]
    );

    return findWorkOrderById(id);
}

/**
 * Lists Work_Orders, optionally filtered by status and/or location, each with its freshly
 * derived Location_Available_Quantity and Shortage_Quantity (Req 5.4).
 *
 * @param {{ status?: string, location?: string }} [filters]
 * @returns {Promise<object[]>}
 */
async function listWorkOrders({ status, location } = {}) {
    const conditions = [];
    const params = [];

    if (status) {
        conditions.push('wo.status = ?');
        params.push(status);
    }
    if (location) {
        conditions.push('wo.location_id = ?');
        params.push(location);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    // Newest first, so a list response is stable across calls rather than in storage order.
    const rows = await query(
        `${WORK_ORDER_SELECT}${where} ORDER BY wo.created_at DESC, wo.id`,
        params
    );

    // The shortage of each row needs its own availability read, so these run together rather
    // than strictly in sequence.
    return Promise.all(
        rows.map(async (row) => {
            const workOrder = toWorkOrder(row);
            return Object.assign(workOrder, await computeShortage(workOrder));
        })
    );
}

/**
 * Reads one Work_Order with its freshly derived shortage (Req 5.4).
 *
 * @param {string} id
 * @returns {Promise<object>}
 * @throws {AppError} 404 NOT_FOUND
 */
async function getWorkOrder(id) {
    const workOrder = await findWorkOrderById(id);
    if (!workOrder) {
        throw notFound();
    }
    return workOrder;
}

/**
 * Advances a Work_Order's status through the one guarded transition function
 * (`nextWorkOrderStatus`), recording `status_changed_at` on success (Req 5.7, 5.8, 5.9).
 *
 * The UPDATE carries `AND status = ?` so the row is only written while it still holds the
 * status the guard was evaluated against. Two concurrent requests to advance the same work
 * order therefore cannot both succeed: the second matches zero rows and is reported as an
 * illegal transition, which is what it has become.
 *
 * @param {{ id: string, targetStatus: string }} input
 * @returns {Promise<object>} the updated work order
 * @throws {AppError} 404 NOT_FOUND; 409 INVALID_STATUS_TRANSITION
 */
async function changeStatus({ id, targetStatus }) {
    const currentRows = await query('SELECT status FROM work_orders WHERE id = ?', [id]);
    if (currentRows.length === 0) {
        throw notFound();
    }

    const currentStatus = currentRows[0].status;
    if (!nextWorkOrderStatus(currentStatus, targetStatus)) {
        throw invalidStatusTransition();
    }

    const result = await query(
        `UPDATE work_orders
            SET status = ?, status_changed_at = CURRENT_TIMESTAMP(3)
          WHERE id = ? AND status = ?`,
        [targetStatus, id, currentStatus]
    );

    if (result.affectedRows !== 1) {
        // Another request advanced it between the read and this write, so the transition the
        // guard approved is no longer the one being asked for.
        throw invalidStatusTransition();
    }

    return findWorkOrderById(id);
}

module.exports = {
    nextWorkOrderStatus,
    createWorkOrder,
    listWorkOrders,
    getWorkOrder,
    changeStatus,
    findWorkOrderById,
    WORK_ORDER_SELECT,
};

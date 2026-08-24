// Work order service: creates work orders, reads them with a freshly derived Shortage_Quantity,
// and advances status through one guarded transition function.
// Shortage is never stored — it's computed from current inventory on every read.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { newId } = require('../db/id');
const { toWorkOrder } = require('../db/mappers');
const { locationAvailableQuantity } = require('./availability');

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

// Status transition rule: current → its one legal successor.
const LEGAL_SUCCESSOR = {
    Assigned: 'InProgress',
    InProgress: 'Completed',
};

/** Returns true when targetStatus is the legal successor of currentStatus. */
function nextWorkOrderStatus(currentStatus, targetStatus) {
    return LEGAL_SUCCESSOR[currentStatus] === targetStatus;
}

/** Shared SELECT for populated work order reads. */
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

/** Computes location available quantity and shortage for a work order at read time. */
async function computeShortage(workOrder) {
    const rows = await query(
        `SELECT physical_quantity, reserved_quantity
           FROM inventory_records
          WHERE item_id = ? AND location_id = ?`,
        [workOrder.item.id, workOrder.location.id]
    );

    const available = locationAvailableQuantity(
        rows.map((row) => ({
            physicalQuantity: row.physical_quantity,
            reservedQuantity: row.reserved_quantity,
        }))
    );

    return {
        locationAvailableQuantity: available,
        shortageQuantity: Math.max(0, workOrder.requiredQuantity - available),
    };
}

/** Reads one work order by id with shortage, or null when absent. */
async function findWorkOrderById(id) {
    const rows = await query(`${WORK_ORDER_SELECT} WHERE wo.id = ?`, [id]);
    if (rows.length === 0) {
        return null;
    }
    const workOrder = toWorkOrder(rows[0]);
    return Object.assign(workOrder, await computeShortage(workOrder));
}

/** Creates a work order in Assigned status. */
async function createWorkOrder({ location, item, requiredQuantity, assignedUser, createdBy = null }) {
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

/** Lists work orders with freshly computed shortage, optionally filtered by status/location. */
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
    const rows = await query(
        `${WORK_ORDER_SELECT}${where} ORDER BY wo.created_at DESC, wo.id`,
        params
    );

    return Promise.all(
        rows.map(async (row) => {
            const workOrder = toWorkOrder(row);
            return Object.assign(workOrder, await computeShortage(workOrder));
        })
    );
}

/**
 * Reads one work order with shortage.
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
 * Advances work order status. The UPDATE carries AND status = ? so concurrent advances cannot both succeed.
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

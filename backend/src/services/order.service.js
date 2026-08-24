// Order service: creates a Customer_Order and reserves stock across batches in one transaction.
// The database decides availability — conditional UPDATEs with row locks defeat the reservation race.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { newId } = require('../db/id');
const { toCustomerOrder } = require('../db/mappers');
const { availableQuantity, hasAvailableAtLeastSql } = require('./availability');
const { isDuplicateKey } = require('./inventory.service');
const { reserveMovementReference } = require('./movementReference');

const invalidReference = () =>
    new AppError(
        ERROR_CODES.INVALID_REFERENCE,
        'INVALID_REFERENCE',
        'The referenced item or location does not exist.'
    );

const notFound = () =>
    new AppError(ERROR_CODES.NOT_FOUND, 'NOT_FOUND', 'Customer order not found.');

const insufficientAvailableQuantity = () =>
    new AppError(
        ERROR_CODES.INSUFFICIENT_AVAILABLE_QUANTITY,
        'INSUFFICIENT_AVAILABLE_QUANTITY',
        'There is not enough available quantity at that location for this order.'
    );

/** Shared SELECT for populated order reads. */
const ORDER_SELECT = `
    SELECT o.id, o.customer_name, o.quantity, o.status, o.created_at, o.updated_at,
           i.id AS item_id, i.code AS item_code, i.name AS item_name,
           c.id AS category_id, c.name AS category_name,
           l.id AS location_id, l.code AS location_code, l.name AS location_name
      FROM customer_orders o
      JOIN items i      ON i.id = o.item_id
      JOIN categories c ON c.id = i.category_id
      JOIN locations l  ON l.id = o.location_id`;

/** Loads reservation lines for a set of orders in one query (avoids N+1). */
async function loadReservations(orderIds) {
    const byOrder = new Map(orderIds.map((id) => [id, []]));
    if (orderIds.length === 0) {
        return byOrder;
    }

    const rows = await query(
        `SELECT customer_order_id, item_id, location_id, batch, quantity
           FROM customer_order_reservations
          WHERE customer_order_id IN (${orderIds.map(() => '?').join(', ')})
          ORDER BY batch`,
        orderIds
    );

    for (const row of rows) {
        byOrder.get(row.customer_order_id).push(row);
    }
    return byOrder;
}

/** Reads one order with its reservation lines, or null. */
async function findOrderById(id) {
    const rows = await query(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
    if (rows.length === 0) {
        return null;
    }
    const reservations = await loadReservations([id]);
    return toCustomerOrder(rows[0], reservations.get(id));
}

/** Lists orders with reservation lines, optionally filtered by status. */
async function listOrders({ status } = {}) {
    const where = status ? ' WHERE o.status = ?' : '';
    const params = status ? [status] : [];
    const rows = await query(`${ORDER_SELECT}${where} ORDER BY o.created_at DESC, o.id`, params);

    const reservations = await loadReservations(rows.map((row) => row.id));
    return rows.map((row) => toCustomerOrder(row, reservations.get(row.id)));
}

/**
 * Reads one order.
 * @throws {AppError} 404 NOT_FOUND
 */
async function getOrder(id) {
    const order = await findOrderById(id);
    if (!order) {
        throw notFound();
    }
    return order;
}

/**
 * Reserves quantity across batches in ascending batch order using conditional UPDATEs.
 * SELECT ... FOR UPDATE serialises concurrent reservations against the same records.
 */
async function reserveAcrossBatches({ item, location, quantity, orderId, createdBy = null }, tx) {
    const [records] = await tx.query(
        `SELECT id, batch, physical_quantity, reserved_quantity
           FROM inventory_records
          WHERE item_id = ? AND location_id = ?
          ORDER BY batch
          FOR UPDATE`,
        [item, location]
    );

    let remaining = quantity;
    const entries = [];

    for (const record of records) {
        if (remaining === 0) break;

        const take = Math.min(
            remaining,
            availableQuantity({
                physicalQuantity: record.physical_quantity,
                reservedQuantity: record.reserved_quantity,
            })
        );
        if (take <= 0) continue;

        // The availability predicate is in the WHERE clause — MySQL evaluates it at write time.
        const guard = hasAvailableAtLeastSql(take);
        const [result] = await tx.query(
            `UPDATE inventory_records
                SET reserved_quantity = reserved_quantity + ?
              WHERE id = ? AND ${guard.sql}`,
            [take, record.id, ...guard.params]
        );

        if (result.affectedRows !== 1) {
            throw insufficientAvailableQuantity();
        }

        try {
            await tx.query(
                `INSERT INTO inventory_transactions
                     (id, inventory_record_id, physical_delta, reserved_delta,
                      movement_reference, created_by)
                 VALUES (?, ?, 0, ?, ?, ?)`,
                [newId(), record.id, take, reserveMovementReference(orderId, record.id), createdBy]
            );
        } catch (error) {
            if (isDuplicateKey(error)) {
                throw insufficientAvailableQuantity();
            }
            throw error;
        }

        entries.push({ item, location, batch: record.batch, quantity: take });
        remaining -= take;
    }

    if (remaining > 0) {
        throw insufficientAvailableQuantity();
    }

    return entries;
}

/** Creates an order and reserves its stock atomically. */
async function createOrder({ customerName, item, location, quantity, createdBy = null }) {
    const orderId = await withTransaction(async (tx) => {
        const [refRows] = await tx.query(
            `SELECT
                 (SELECT COUNT(*) FROM items     WHERE id = ?) AS itemCount,
                 (SELECT COUNT(*) FROM locations WHERE id = ?) AS locationCount`,
            [item, location]
        );
        if (refRows[0].itemCount !== 1 || refRows[0].locationCount !== 1) {
            throw invalidReference();
        }

        const id = newId();

        await tx.query(
            `INSERT INTO customer_orders
                 (id, customer_name, item_id, location_id, quantity, status, created_by)
             VALUES (?, ?, ?, ?, ?, 'Reserved', ?)`,
            [id, customerName, item, location, quantity, createdBy]
        );

        const entries = await reserveAcrossBatches(
            { item, location, quantity, orderId: id, createdBy },
            tx
        );

        for (const entry of entries) {
            await tx.query(
                `INSERT INTO customer_order_reservations
                     (id, customer_order_id, item_id, location_id, batch, quantity)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [newId(), id, entry.item, entry.location, entry.batch, entry.quantity]
            );
        }

        return id;
    });

    return findOrderById(orderId);
}

module.exports = {
    createOrder,
    listOrders,
    getOrder,
    findOrderById,
    reserveAcrossBatches,
    ORDER_SELECT,
};

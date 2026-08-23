// backend/src/services/order.service.js -- the Order_Service: creates a Customer_Order and
// reserves its stock across batches in one transaction (Req 7.1-7.12, 15.3, 15.5, 15.6).
//
// This is the file the brief's hardest requirement lands on: two users must not be able to
// reserve more stock than exists, and it has to be solved at the database level. See
// `reserveAcrossBatches` below for how, and why it cannot lose the race.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { query } = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { newId } = require('../db/id');
const { toCustomerOrder } = require('../db/mappers');
const { availableQuantity, hasAvailableAtLeastSql } = require('./availability');
const { isDuplicateKey } = require('./inventory.service');
const { reserveMovementReference } = require('./movementReference');

// --- error builders -------------------------------------------------------------------

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

// --- reads -----------------------------------------------------------------------------

const ORDER_SELECT = `
    SELECT o.id, o.customer_name, o.quantity, o.status, o.created_at, o.updated_at,
           i.id AS item_id, i.code AS item_code, i.name AS item_name,
           c.id AS category_id, c.name AS category_name,
           l.id AS location_id, l.code AS location_code, l.name AS location_name
      FROM customer_orders o
      JOIN items i      ON i.id = o.item_id
      JOIN categories c ON c.id = i.category_id
      JOIN locations l  ON l.id = o.location_id`;

/**
 * Loads the reservation lines of one or more orders, keyed by order id.
 *
 * Fetched in a single query for every order in the list rather than one query per order,
 * because the alternative is the classic N+1: a list of 50 orders would otherwise issue 51
 * round trips. Ordered by batch so the lines come back in the ascending order they were
 * consumed in (Req 15.6).
 *
 * @param {string[]} orderIds
 * @returns {Promise<Map<string, object[]>>}
 */
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

/** Reads one order with its reservation lines, or null when absent. */
async function findOrderById(id) {
    const rows = await query(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
    if (rows.length === 0) {
        return null;
    }
    const reservations = await loadReservations([id]);
    return toCustomerOrder(rows[0], reservations.get(id));
}

/**
 * Lists Customer_Orders, optionally filtered by status, each with its reservation lines.
 *
 * @param {{ status?: string }} [filters]
 * @returns {Promise<object[]>}
 */
async function listOrders({ status } = {}) {
    const where = status ? ' WHERE o.status = ?' : '';
    const params = status ? [status] : [];
    const rows = await query(`${ORDER_SELECT}${where} ORDER BY o.created_at DESC, o.id`, params);

    const reservations = await loadReservations(rows.map((row) => row.id));
    return rows.map((row) => toCustomerOrder(row, reservations.get(row.id)));
}

/**
 * Reads one Customer_Order (Req 7.12).
 *
 * @param {string} id
 * @throws {AppError} 404 NOT_FOUND
 */
async function getOrder(id) {
    const order = await findOrderById(id);
    if (!order) {
        throw notFound();
    }
    return order;
}

// --- the reservation ---------------------------------------------------------------------

/**
 * Reserves `quantity` units of one Item at one Location by increasing the reserved_quantity of
 * its inventory_records in ascending batch order, consuming each record's full availability
 * before moving to the next (Req 7.1).
 *
 * THE DATABASE DECIDES, NOT THE READ (Req 7.4, 15.5). Two mechanisms do the work:
 *
 *   1. `SELECT ... FOR UPDATE` on the candidate rows. InnoDB holds those row locks until this
 *      transaction commits, so a second transaction reserving from the same batch BLOCKS here
 *      rather than reading a value that is about to go stale.
 *
 *   2. The `UPDATE ... WHERE (physical_quantity - reserved_quantity) >= ?` predicate, from
 *      availability.js. Availability is re-evaluated by MySQL at the moment the write applies.
 *      The accept/reject decision is `affectedRows === 1` -- never a JS comparison against a
 *      number read earlier.
 *
 * WHY THIS DEFEATS THE BRIEF'S RACE: availability 100, request A reserving 80 and request B
 * reserving 50, submitted together.
 *
 *   A naive read-then-write would have both read 100, both conclude their amount fits, both
 *   increment, and leave reserved_quantity 130 against physical_quantity 100 -- an oversell.
 *
 *   Here, whichever transaction reaches the FOR UPDATE first holds the row lock. The other
 *   waits. When the winner commits, the loser acquires the lock and re-reads
 *   reserved_quantity as 80, so its `take` is recomputed against 20 available, its predicate
 *   `20 >= 50` fails, `affectedRows` is 0, and it throws INSUFFICIENT_AVAILABLE_QUANTITY. Its
 *   whole transaction rolls back, so any partial reservation it had already made against an
 *   earlier batch is undone too.
 *
 *   If the two instead deadlock, MySQL rolls one back with ER_LOCK_DEADLOCK, which
 *   src/db/withTransaction.js treats as transient and retries from the first read -- where it
 *   then sees the winner's committed effect and is rejected on the merits.
 *
 *   Either way exactly one of the two commits, and reserved_quantity never exceeds
 *   physical_quantity -- a bound the schema's CHECK constraint also enforces independently
 *   (Req 7.5, 7.6, 7.7).
 *
 * @param {{ item: string, location: string, quantity: number, orderId: string, createdBy?: string|null }} input
 * @param {import('mysql2/promise').PoolConnection} tx the caller's transaction connection
 * @returns {Promise<Array<{ item: string, location: string, batch: string, quantity: number }>>}
 *   the reservation lines; their quantities sum to `quantity` (Req 15.3, 15.6)
 * @throws {AppError} 409 INSUFFICIENT_AVAILABLE_QUANTITY
 */
async function reserveAcrossBatches({ item, location, quantity, orderId, createdBy = null }, tx) {
    // Ascending batch order (Req 7.1, 15.6), locked for the duration of this transaction.
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

        // A candidate size only -- choosing this reserves nothing by itself.
        const take = Math.min(
            remaining,
            availableQuantity({
                physicalQuantity: record.physical_quantity,
                reservedQuantity: record.reserved_quantity,
            })
        );
        if (take <= 0) continue;

        // The availability condition lives in the WHERE clause, evaluated by MySQL as it
        // applies the write (Req 7.4). Built by availability.js so the formula is not
        // restated here (Req 15.1).
        const guard = hasAvailableAtLeastSql(take);
        const [result] = await tx.query(
            `UPDATE inventory_records
                SET reserved_quantity = reserved_quantity + ?
              WHERE id = ? AND ${guard.sql}`,
            [take, record.id, ...guard.params]
        );

        if (result.affectedRows !== 1) {
            // Availability disappeared between the read and this write. The write's own
            // result IS the decision (Req 7.4) -- there is nothing left to re-check.
            throw insufficientAvailableQuantity();
        }

        // One ledger row per changed record, in the same transaction as the update it
        // describes -- the same discipline applyMovement enforces everywhere else
        // (Req 4.4, 8.1). Written directly rather than through applyMovement because this
        // update's guard is reserved-only (Req 7.4), not applyMovement's combined
        // physical-and-available guard.
        try {
            await tx.query(
                `INSERT INTO inventory_transactions
                     (id, inventory_record_id, physical_delta, reserved_delta,
                      movement_reference, created_by)
                 VALUES (?, ?, 0, ?, ?, ?)`,
                [newId(), record.id, take, reserveMovementReference(orderId, record.id), createdBy]
            );
        } catch (error) {
            // The same order reserving the same record twice would mean this function ran
            // twice for one order id, which the unique movement_reference refuses.
            if (isDuplicateKey(error)) {
                throw insufficientAvailableQuantity();
            }
            throw error;
        }

        entries.push({ item, location, batch: record.batch, quantity: take });
        remaining -= take;
    }

    if (remaining > 0) {
        // Not enough total availability across every batch at this location, even though each
        // individual update that was attempted matched (Req 7.3).
        throw insufficientAvailableQuantity();
    }

    return entries; // sums to `quantity` (Req 15.3, 15.6)
}

/**
 * Creates a Customer_Order and reserves its stock, both in one transaction (Req 7.1).
 *
 * Either the order row, every reservation line, every reserved_quantity increase, and every
 * ledger row all commit, or none of them do: a rejected reservation leaves no order behind
 * (Req 7.3, 8.2).
 *
 * @param {{ customerName: string, item: string, location: string, quantity: number, createdBy?: string|null }} input
 * @returns {Promise<object>} the created order with its reservation lines
 * @throws {AppError} 400 INVALID_REFERENCE; 409 INSUFFICIENT_AVAILABLE_QUANTITY
 */
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

        // Generated up front so the reservation lines and their ledger rows can all name the
        // order inside this one transaction.
        const id = newId();

        await tx.query(
            `INSERT INTO customer_orders
                 (id, customer_name, item_id, location_id, quantity, status, created_by)
             VALUES (?, ?, ?, ?, ?, 'Reserved', ?)`,
            [id, customerName, item, location, quantity, createdBy]
        );

        // Throws before any of the above is visible if the stock is not there (Req 7.3).
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

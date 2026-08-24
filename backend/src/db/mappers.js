// backend/src/db/mappers.js -- turns flat JOIN result rows into the nested API response
// objects each controller returns directly.
//
// Why this file exists: a SQL JOIN returns one flat row with columns like `item_code` and
// `category_name`. Rebuilding the nested response shape here isolates the SQL aliasing
// convention from controllers: each controller returns the mapper output without further
// transformation.
//
// Naming convention these mappers rely on: every JOINed SELECT aliases its columns as
// `<relation>_<field>`, e.g. `i.code AS item_code`, `c.name AS category_name`. The mappers
// read those exact aliases, so a query that renames a column has to rename it here too --
// which is the point: one place to look.
//
// `availableQuantity` and `shortageQuantity` are NOT computed here. They come from
// src/services/availability.js and the work order service respectively, so the derivation
// rules stay in one place each (Req 15.1).

const { availableQuantity } = require('../services/availability');

/** `{ id, name }` from `category_*` columns. */
function toCategory(row) {
    return { id: row.category_id, name: row.category_name };
}

/** `{ id, code, name, category }` from `item_*` and `category_*` columns. */
function toItem(row) {
    return {
        id: row.item_id,
        code: row.item_code,
        name: row.item_name,
        category: toCategory(row),
    };
}

/**
 * `{ id, code, name }` from `<prefix>_*` columns.
 *
 * Prefixed because a transfer row carries two locations at once
 * (`source_location_*` and `destination_location_*`), so the caller names which.
 */
function toLocation(row, prefix = 'location') {
    return {
        id: row[`${prefix}_id`],
        code: row[`${prefix}_code`],
        name: row[`${prefix}_name`],
    };
}

/** `{ id, email, role }` from `assigned_user_*` columns. Never carries password_hash. */
function toAssignedUser(row) {
    return {
        id: row.assigned_user_id,
        email: row.assigned_user_email,
        role: row.assigned_user_role,
    };
}

/**
 * One inventory_records JOIN row, shaped as the final API response object.
 *
 * `availableQuantity` is derived, never stored (Req 3.3).
 */
function toInventoryRecord(row) {
    const record = {
        id: row.id,
        item: toItem(row),
        location: toLocation(row),
        batch: row.batch,
        physicalQuantity: row.physical_quantity,
        reservedQuantity: row.reserved_quantity,
    };
    record.availableQuantity = availableQuantity(record);
    return record;
}

/**
 * One work_orders JOIN row. `locationAvailableQuantity` and `shortageQuantity` are added by
 * the work order service after this mapper runs, because they need a second query (the
 * availability of the item at the location) that a single row cannot carry.
 */
function toWorkOrder(row) {
    return {
        id: row.id,
        location: toLocation(row),
        item: toItem(row),
        requiredQuantity: row.required_quantity,
        assignedUser: toAssignedUser(row),
        status: row.status,
        statusChangedAt: row.status_changed_at,
        createdAt: row.created_at,
    };
}

/** One internal_transfers JOIN row, carrying both of its locations. */
function toInternalTransfer(row) {
    return {
        id: row.id,
        item: toItem(row),
        batch: row.batch,
        sourceLocation: toLocation(row, 'source_location'),
        destinationLocation: toLocation(row, 'destination_location'),
        quantity: row.quantity,
        receivedQuantity: row.received_quantity,
        status: row.status,
        createdAt: row.created_at,
        dispatchedAt: row.dispatched_at,
        receivedAt: row.received_at,
    };
}

/**
 * One customer_order_reservations row.
 *
 * Reservations are stored as a child table but this mapper exposes only the four business
 * fields the API returns -- item id, location id, batch, and quantity.
 */
function toReservation(row) {
    return {
        item: row.item_id,
        location: row.location_id,
        batch: row.batch,
        quantity: row.quantity,
    };
}

/**
 * One customer_orders JOIN row plus its reservation rows.
 *
 * @param {object} row the joined order row
 * @param {object[]} reservationRows rows from customer_order_reservations for this order
 */
function toCustomerOrder(row, reservationRows = []) {
    return {
        id: row.id,
        customerName: row.customer_name,
        item: toItem(row),
        location: toLocation(row),
        quantity: row.quantity,
        status: row.status,
        reservations: reservationRows.map(toReservation),
        createdAt: row.created_at,
    };
}

/** One users row for the reference list: id, email, role only (Req 1.1). */
function toUserRef(row) {
    return { id: row.id, email: row.email, role: row.role };
}

module.exports = {
    toCategory,
    toItem,
    toLocation,
    toAssignedUser,
    toInventoryRecord,
    toWorkOrder,
    toInternalTransfer,
    toReservation,
    toCustomerOrder,
    toUserRef,
};

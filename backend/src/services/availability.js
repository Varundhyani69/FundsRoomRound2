// Availability service: the single source of truth for Available_Quantity.
// One formula (physical − reserved) expressed as JS, SQL expression, and WHERE predicate.

/**
 * Available quantity for a single inventory record.
 * @param {{ physicalQuantity: number, reservedQuantity: number }} record
 * @returns {number}
 */
function availableQuantity(record) {
    return record.physicalQuantity - record.reservedQuantity;
}

/**
 * Sum of available quantity across records for one item at one location.
 * @param {Array<{ physicalQuantity: number, reservedQuantity: number }>} records
 * @returns {number} 0 for an empty array
 */
function locationAvailableQuantity(records) {
    return records.reduce((total, record) => total + availableQuantity(record), 0);
}

/** SQL expression for available quantity (unqualified column names). */
const AVAILABLE_SQL = '(physical_quantity - reserved_quantity)';

/** AVAILABLE_SQL qualified with a table alias. */
function AVAILABLE_SQL_FOR(alias) {
    return `(${alias}.physical_quantity - ${alias}.reserved_quantity)`;
}

/**
 * WHERE-clause predicate for conditional UPDATEs that check availability atomically.
 * @param {number} quantity
 * @returns {{ sql: string, params: number[] }}
 */
function hasAvailableAtLeastSql(quantity, alias = null) {
    const available = alias ? AVAILABLE_SQL_FOR(alias) : AVAILABLE_SQL;
    return { sql: `${available} >= ?`, params: [quantity] };
}

/**
 * WHERE-clause predicate checking physical_quantity >= quantity.
 * @param {number} quantity
 * @returns {{ sql: string, params: number[] }}
 */
function hasPhysicalAtLeastSql(quantity, alias = null) {
    const physical = alias ? `${alias}.physical_quantity` : 'physical_quantity';
    return { sql: `${physical} >= ?`, params: [quantity] };
}

module.exports = {
    availableQuantity,
    locationAvailableQuantity,
    AVAILABLE_SQL,
    AVAILABLE_SQL_FOR,
    hasAvailableAtLeastSql,
    hasPhysicalAtLeastSql,
};

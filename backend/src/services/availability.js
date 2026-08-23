// backend/src/services/availability.js -- the single source of truth for Available_Quantity:
// it is the only module in the codebase that subtracts `reservedQuantity` from
// `physicalQuantity` (Req 3.3, 3.4, 3.5, 3.12, 15.1).
//
// Three shapes of the same rule live here side by side on purpose:
//   * `availableQuantity` / `locationAvailableQuantity` -- the JS form every read path and
//     every in-process guard calls.
//   * `AVAILABLE_SQL` -- the SQL expression a SELECT projects, so a read never
//     recomputes the formula in a query string of its own.
//   * `hasAvailableAtLeastSql` -- the predicate every conditional UPDATE appends to its
//     WHERE clause, so the DATABASE decides availability atomically as part of the write
//     instead of the application trusting a value it read earlier (Req 7.4).
//
// The third one is what makes concurrent reservations safe. An UPDATE of the form
//     UPDATE inventory_records
//        SET reserved_quantity = reserved_quantity + ?
//      WHERE id = ? AND (physical_quantity - reserved_quantity) >= ?
// is evaluated by MySQL while holding a row lock on that row, so two concurrent
// reservations are serialised by InnoDB: the second one re-evaluates the predicate against
// the first one's committed effect and matches zero rows. The caller decides from
// `affectedRows`, never from a prior SELECT -- which is why there is no read-then-write
// race to lose (Req 7.5, 7.6, 7.7).
//
// EXTENSIBILITY (Req 15.1): adding a further deducted component -- a `damaged_quantity`,
// say -- means editing this one file plus the schema, and nothing else:
//   1. subtract the new field in `availableQuantity` below, and
//   2. add the same column to `AVAILABLE_SQL` (which `hasAvailableAtLeastSql` reuses), and
//   3. add the column to `inventory_records` in src/db/schema.sql.
// Every caller then picks the new rule up unchanged, which only holds while no controller,
// no other service, and no hand-written query restates the formula.
//
// The JS functions take plain row objects, so nothing here depends on how a row was
// fetched and the rule stays trivially unit-testable.

/**
 * The one and only definition of Available_Quantity for a single Inventory_Record (Req 3.3).
 *
 * @param {{ physicalQuantity: number, reservedQuantity: number }} record
 * @returns {number} `physicalQuantity - reservedQuantity`
 */
function availableQuantity(record) {
    return record.physicalQuantity - record.reservedQuantity;
}

/**
 * Location_Available_Quantity: the sum of Available_Quantity across records for one Item at
 * one Location, irrespective of Batch identifier (Req 3.5).
 *
 * An empty array reduces to 0, which is what makes an availability read for an Item and
 * Location with no records answer 0 rather than NOT_FOUND (Req 3.12).
 *
 * @param {Array<{ physicalQuantity: number, reservedQuantity: number }>} records
 * @returns {number} 0 for an empty array
 */
function locationAvailableQuantity(records) {
    return records.reduce((total, record) => total + availableQuantity(record), 0);
}

/**
 * The same rule as a SQL expression over `inventory_records`, for a SELECT to project as a
 * derived column. Written against unqualified column names, so a query that aliases the
 * table must alias this too -- `AVAILABLE_SQL_FOR('ir')` exists for that case.
 */
const AVAILABLE_SQL = '(physical_quantity - reserved_quantity)';

/**
 * `AVAILABLE_SQL` qualified with a table alias, for the JOINed reads.
 *
 * @param {string} alias e.g. `'ir'`
 * @returns {string} e.g. `(ir.physical_quantity - ir.reserved_quantity)`
 */
function AVAILABLE_SQL_FOR(alias) {
    return `(${alias}.physical_quantity - ${alias}.reserved_quantity)`;
}

/**
 * The availability rule as a WHERE-clause predicate plus its bound parameter, so a
 * conditional UPDATE decides availability inside the write itself (Req 7.4).
 *
 * Returns the fragment and its parameter separately rather than an interpolated string,
 * because the quantity is a VALUE and must travel as a bound `?` parameter -- never
 * concatenated into SQL.
 *
 * Usage:
 *     const guard = hasAvailableAtLeastSql(take);
 *     await tx.query(
 *         `UPDATE inventory_records
 *             SET reserved_quantity = reserved_quantity + ?
 *           WHERE id = ? AND ${guard.sql}`,
 *         [take, recordId, ...guard.params]
 *     );
 *     // decide on result.affectedRows === 1, never on a prior SELECT
 *
 * @param {number} quantity
 * @returns {{ sql: string, params: number[] }}
 */
function hasAvailableAtLeastSql(quantity, alias = null) {
    const available = alias ? AVAILABLE_SQL_FOR(alias) : AVAILABLE_SQL;
    return { sql: `${available} >= ?`, params: [quantity] };
}

/**
 * The mirror guard for a physical decrease: "this record has at least `quantity` physical".
 * Kept here beside the availability rule so both quantity predicates a conditional update
 * can carry live in one file (Req 4.2).
 *
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

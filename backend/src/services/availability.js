// backend/src/services/availability.js -- the single source of truth for Available_Quantity:
// it is the only module in the codebase that subtracts `reservedQuantity` from
// `physicalQuantity` (Req 3.3, 3.4, 3.5, 3.12, 15.1).
//
// Two shapes of the same rule live here side by side on purpose:
//   * `availableQuantity` / `locationAvailableQuantity` -- the JS form every read path and
//     every in-process guard calls.
//   * `hasAvailableAtLeastExpr` -- the MongoDB form every conditional update embeds, so the
//     server decides availability atomically instead of trusting a value read earlier
//     (Req 7.4).
//
// EXTENSIBILITY (Req 15.1): adding a further deducted component -- a `damagedQuantity`, say --
// means editing this one file plus the Inventory_Record schema, and nothing else:
//   1. subtract the new field in `availableQuantity` below, and
//   2. add the same field to the `$subtract` array in `hasAvailableAtLeastExpr`, and
//   3. add the field to `backend/src/models/InventoryRecord.js`.
// Every caller then picks the new rule up unchanged, which only holds while no controller,
// no other service, and no aggregation pipeline restates the formula.
//
// The functions take plain record objects rather than Mongoose documents, so nothing here
// depends on the model and the rule stays trivially unit-testable.

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
 * The same rule expressed as a query filter fragment, so a conditional update can decide
 * availability server-side and the decision comes from the update's match result rather than
 * from a value read before it (Req 7.4).
 *
 * Reads as "this record has at least `quantity` available". Spread into the filter alongside
 * the record identifier, e.g.
 * `updateOne({ _id: record._id, ...hasAvailableAtLeastExpr(take) }, { $inc: { reservedQuantity: take } })`.
 *
 * @param {number} quantity
 * @returns {{ $expr: object }} a MongoDB filter fragment
 */
function hasAvailableAtLeastExpr(quantity) {
    return {
        $expr: {
            $gte: [{ $subtract: ['$physicalQuantity', '$reservedQuantity'] }, quantity],
        },
    };
}

module.exports = {
    availableQuantity,
    locationAvailableQuantity,
    hasAvailableAtLeastExpr,
};

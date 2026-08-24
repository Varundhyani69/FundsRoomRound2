// backend/tests/setup/generators.js -- the shared fast-check arbitraries used across
// backend/tests/properties/*.pbt.test.js, so each one is declared exactly once
// (design.md "Shared generators", Req 12.7).
//
// Every property test that needs "a quantity", "a batch", "an id that doesn't exist" etc.
// imports from here rather than rolling its own, so a change to what a valid quantity or
// batch looks like (backend/src/validation/common.js, backend/src/models/fields.js) is one
// edit instead of a hunt through every *.pbt.test.js file.

const fc = require('fast-check');

const HEX_CHARS = '0123456789abcdef';
const IDENTIFIER_PATTERN = /^[a-f0-9]{24}$/i;

// The fixture's fixed ids (backend/tests/setup/seedFixture.js) all share the same 21-zero
// prefix, e.g. '000000000000000000000a01'. Filtering that prefix out of a random 24-hex
// generator makes collision with a fixture id impossible rather than merely unlikely, so
// there is no need for the generator to know the fixture's actual ids.
const FIXTURE_ID_PREFIX = '000000000000000000000';

// --- genQuantity ---------------------------------------------------------------
// Valid_Quantity: an integer from 1 to 1,000,000 (backend/src/validation/common.js,
// backend/src/models/fields.js). Off-by-one bugs live at the edges, so those are
// over-represented rather than left to chance.
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 1_000_000;

const genQuantity = fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(1, 2, 999_999, 1_000_000) },
    { weight: 6, arbitrary: fc.integer({ min: QUANTITY_MIN, max: QUANTITY_MAX }) }
);

// --- genInvalidQuantity ----------------------------------------------------------
// Every distinct way a quantity can fail validation: zero, negative, above the max,
// non-integer, NaN, an out-of-range numeric string, null, and absent (represented as
// `undefined`, since fast-check has no way to "omit" a value -- callers that build a
// request body should `delete` the field when they see `undefined`).
//
// The numeric-string branch deliberately stringifies an OUT-OF-RANGE number rather than
// one from the valid 1..1,000,000 range: `validQuantity` (backend/src/validation/common.js)
// coerces a numeric string with `Number(value)` before validating, so a string like "500"
// is coerced to the valid number 500 and is NOT invalid. Only a string whose coerced value
// still falls outside the valid range (or isn't a whole number) is actually invalid.
const genOutOfRangeNumber = fc.oneof(
    fc.constant(0),
    fc.integer({ max: -1 }),
    fc.integer({ min: QUANTITY_MAX + 1, max: QUANTITY_MAX + 1_000_000 })
);

const genInvalidQuantity = fc.oneof(
    fc.constant(0),
    fc.integer({ max: -1 }),
    fc.integer({ min: QUANTITY_MAX + 1, max: QUANTITY_MAX + 1_000_000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
    fc.constant(NaN),
    genOutOfRangeNumber.map(String),
    fc.constant(null),
    fc.constant(undefined)
);

// --- genBatch --------------------------------------------------------------------
// Batch label validation (backend/src/validation/common.js): trimmed, non-blank, at most
// 32 characters. The generator produces the raw, pre-trim value a client would send, so a
// value can carry leading/trailing whitespace padding as long as what remains after
// trimming is still 1..32 characters.
const genBatchCore = fc
    .oneof(
        fc.string({ minLength: 1, maxLength: 32 }),
        // A pool of non-ASCII characters, so a batch label is not implicitly ASCII-only.
        fc.stringOf(fc.constantFrom('é', 'ñ', '中', '文', '😀', 'Ω', 'ß', 'ü'), {
            minLength: 1,
            maxLength: 32,
        })
    )
    .filter((s) => s.trim().length >= 1 && s.trim().length <= 32);

const genWhitespacePadding = fc.constantFrom('', ' ', '  ', '\t', '\n', ' \t ');

const genPaddedBatch = fc
    .tuple(genWhitespacePadding, genBatchCore, genWhitespacePadding)
    .map(([before, core, after]) => before + core + after);

const genBatch = fc.oneof(
    { weight: 2, arbitrary: genBatchCore },
    { weight: 1, arbitrary: genPaddedBatch }
);

// --- genRecordLayout ---------------------------------------------------------------
// 0..5 Inventory_Records for one item/location, each `{ batch, physicalQuantity,
// reservedQuantity }` with `reservedQuantity <= physicalQuantity` always holding (the
// invariant of Req 3.8, 3.9). Batches are deduplicated by their trimmed value, because the
// unique index is on `{ item, location, batch }` and these records all share one item and
// one location.
const genPhysicalReservedPair = fc
    .integer({ min: 0, max: QUANTITY_MAX })
    .chain((physicalQuantity) =>
        fc.integer({ min: 0, max: physicalQuantity }).map((reservedQuantity) => ({
            physicalQuantity,
            reservedQuantity,
        }))
    );

const genRecordLayout = fc.uniqueArray(
    fc.tuple(genBatch, genPhysicalReservedPair).map(([batch, quantities]) => ({
        batch,
        ...quantities,
    })),
    { minLength: 0, maxLength: 5, selector: (record) => record.batch.trim().toLowerCase() }
);

// --- genOperationSequence -----------------------------------------------------------
// 1..20 operations for the invariant/ledger properties (Property 2, Property 4). As of
// increment 5 only three operations exist; this map is deliberately a plain object rather
// than an inline array so a later increment (transfers, orders) extends it with
// `createTransfer`, `dispatch`, `receive`, `createOrder` by adding one more entry instead
// of restructuring the generator.
const OPERATION_GENERATORS = {
    createRecord: fc.record({
        type: fc.constant('createRecord'),
        batch: genBatch,
        physicalQuantity: genQuantity,
    }),
    adjustIn: fc.record({
        type: fc.constant('adjustIn'),
        quantity: genQuantity,
    }),
    adjustOut: fc.record({
        type: fc.constant('adjustOut'),
        quantity: genQuantity,
    }),
};

const genOperation = fc.oneof(...Object.values(OPERATION_GENERATORS));

const genOperationSequence = fc.array(genOperation, { minLength: 1, maxLength: 20 });

// --- genUnusedId ---------------------------------------------------------------
// A well-formed 24-character hex id guaranteed not to collide with a fixture id. Random
// 24-hex collision with a specific id is already negligible (1 in 16^24); excluding the
// fixture's fixed prefix makes it impossible instead of merely negligible, at no extra
// cost.
const genHexChar = fc.constantFrom(...HEX_CHARS.split(''));

const genUnusedId = fc
    .stringOf(genHexChar, { minLength: 24, maxLength: 24 })
    .filter((id) => !id.startsWith(FIXTURE_ID_PREFIX));

// --- genMalformedId ------------------------------------------------------------------
// Every distinct way an id fails the `/^[a-f0-9]{24}$/i` check (backend/src/validation/
// common.js): wrong length in either direction, right length but with a character outside
// the hex range (including uppercase letters past 'F', which the case-insensitive regex
// still rejects), the empty string, and arbitrary non-hex garbage.
const genNonHexChar = fc.constantFrom(
    ...'ghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ!@#$%^&*() _-'.split('')
);

const genMalformedId = fc.oneof(
    fc.stringOf(genHexChar, { minLength: 23, maxLength: 23 }),
    fc.stringOf(genHexChar, { minLength: 25, maxLength: 25 }),
    fc.stringOf(genNonHexChar, { minLength: 24, maxLength: 24 }),
    fc.constant(''),
    fc.string().filter((s) => !IDENTIFIER_PATTERN.test(s))
);

// --- genRole -----------------------------------------------------------------------
// Every valid Role (backend/src/permissions.js `ROLES`), plus a handful of concrete
// out-of-enum strings including near-misses (wrong case, plural) that a naive string
// comparison could wrongly accept.
const VALID_ROLES = ['Admin', 'OperationsUser', 'SalesUser'];
const INVALID_ROLE_SAMPLES = ['Root', 'admin', 'OperationsUsers', 'SALESUSER', '', 'Guest'];

const genRole = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...VALID_ROLES) },
    { weight: 1, arbitrary: fc.constantFrom(...INVALID_ROLE_SAMPLES) }
);

// --- genConcurrentQuantities ---------------------------------------------------------
// A generated availability and 2..5 positive quantities whose sum always exceeds it, for
// testing that concurrent reservations/dispatches cannot oversell (Req 7.4-7.8). The sum is
// guaranteed by construction (the last quantity is bumped up if needed) rather than by
// `.filter()`, so fast-check never has to search for a matching combination and shrinking
// stays well-behaved.
const genConcurrentQuantities = fc.integer({ min: 1, max: 1000 }).chain((availability) =>
    fc
        .array(fc.integer({ min: 1, max: Math.max(1, availability) }), {
            minLength: 2,
            maxLength: 5,
        })
        .map((quantities) => {
            const sum = quantities.reduce((total, q) => total + q, 0);
            if (sum > availability) return { availability, quantities };

            const bumped = [...quantities];
            bumped[bumped.length - 1] += availability - sum + 1;
            return { availability, quantities: bumped };
        })
);

module.exports = {
    genQuantity,
    genInvalidQuantity,
    genBatch,
    genRecordLayout,
    OPERATION_GENERATORS,
    genOperationSequence,
    genUnusedId,
    genMalformedId,
    genRole,
    genConcurrentQuantities,
    // Exported for reuse by tests that need "just an id shape" without the
    // fixture-collision-avoidance filter (e.g. building a second unrelated id).
    IDENTIFIER_PATTERN,
};

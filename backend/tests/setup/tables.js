// backend/tests/setup/tables.js -- read-only table accessors for the test suite.
//
// The tests assert against stored state constantly ("the record is unchanged", "no order
// exists", "the ledger has one row"). Before the MySQL migration they did that through the
// Mongoose models. Those are gone, and rewriting every assertion as inline SQL would bury
// what each test is actually checking under query strings.
//
// So this module offers the small slice of the Mongoose read API the tests actually used --
// `find`, `findOne`, `findById`, `countDocuments`, `exists` -- backed by SQL, returning rows
// mapped to the camelCase field names the tests already expect. A test file's assertions
// therefore did not have to change; only its import line did.
//
// Mostly READ-ONLY. Tests reach the application through HTTP wherever the API can express
// what they need, and the reads below are how they then check what was stored.
//
// `create`, `updateOne` and `updateMany` exist for the cases the API deliberately cannot
// express, which is where the property tests live: there is no endpoint that creates an Item,
// and none that sets `reservedQuantity` directly, so a generated starting layout ("five
// batches with these physical/reserved pairs") can only be installed by inserting it. Those
// three are for arranging a precondition, never for asserting an outcome -- every property
// then drives the real routes and checks the real stored result.
//
// `_id` is exposed alongside `id` because the assertions were written against Mongoose
// documents; both name the same CHAR(24) primary key.

const { query } = require('../../src/db/pool');
const { newId } = require('../../src/db/id');

/**
 * Per-table column maps: `apiField -> column`. Only fields a test reads are listed, which
 * doubles as documentation of what the suite actually depends on.
 */
const TABLES = {
    users: {
        table: 'users',
        fields: {
            _id: 'id',
            id: 'id',
            email: 'email',
            passwordHash: 'password_hash',
            role: 'role',
            assignedLocation: 'assigned_location_id',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        },
    },
    categories: {
        table: 'categories',
        fields: { _id: 'id', id: 'id', name: 'name' },
    },
    locations: {
        table: 'locations',
        fields: { _id: 'id', id: 'id', code: 'code', name: 'name' },
    },
    items: {
        table: 'items',
        fields: { _id: 'id', id: 'id', code: 'code', name: 'name', category: 'category_id' },
    },
    inventoryRecords: {
        table: 'inventory_records',
        fields: {
            _id: 'id',
            id: 'id',
            item: 'item_id',
            location: 'location_id',
            batch: 'batch',
            physicalQuantity: 'physical_quantity',
            reservedQuantity: 'reserved_quantity',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        },
    },
    inventoryTransactions: {
        table: 'inventory_transactions',
        fields: {
            _id: 'id',
            id: 'id',
            inventoryRecord: 'inventory_record_id',
            physicalDelta: 'physical_delta',
            reservedDelta: 'reserved_delta',
            movementReference: 'movement_reference',
            appliedAt: 'applied_at',
            createdBy: 'created_by',
        },
    },
    workOrders: {
        table: 'work_orders',
        fields: {
            _id: 'id',
            id: 'id',
            location: 'location_id',
            item: 'item_id',
            requiredQuantity: 'required_quantity',
            assignedUser: 'assigned_user_id',
            status: 'status',
            statusChangedAt: 'status_changed_at',
            createdBy: 'created_by',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        },
    },
    internalTransfers: {
        table: 'internal_transfers',
        fields: {
            _id: 'id',
            id: 'id',
            item: 'item_id',
            batch: 'batch',
            sourceLocation: 'source_location_id',
            destinationLocation: 'destination_location_id',
            quantity: 'quantity',
            receivedQuantity: 'received_quantity',
            status: 'status',
            dispatchedAt: 'dispatched_at',
            receivedAt: 'received_at',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        },
    },
    customerOrders: {
        table: 'customer_orders',
        fields: {
            _id: 'id',
            id: 'id',
            customerName: 'customer_name',
            item: 'item_id',
            location: 'location_id',
            quantity: 'quantity',
            status: 'status',
            createdBy: 'created_by',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        },
    },
    customerOrderReservations: {
        table: 'customer_order_reservations',
        fields: {
            _id: 'id',
            id: 'id',
            customerOrder: 'customer_order_id',
            item: 'item_id',
            location: 'location_id',
            batch: 'batch',
            quantity: 'quantity',
        },
    },
};

/** Builds a WHERE clause from an `{ apiField: value }` filter. */
function buildWhere(spec, filter = {}) {
    const entries = Object.entries(filter).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
        return { sql: '', params: [] };
    }

    const clauses = [];
    const params = [];

    for (const [field, value] of entries) {
        const column = spec.fields[field];
        if (!column) {
            throw new Error(
                `tests/setup/tables.js: "${field}" is not a mapped field of ${spec.table}. ` +
                `Add it to the field map if a test needs it.`
            );
        }
        // `{ $in: [...] }` is the one Mongoose operator the suite used.
        if (value && typeof value === 'object' && Array.isArray(value.$in)) {
            if (value.$in.length === 0) {
                // An empty $in matches nothing; `IN ()` is a syntax error in MySQL.
                clauses.push('1 = 0');
            } else {
                clauses.push(`${column} IN (${value.$in.map(() => '?').join(', ')})`);
                params.push(...value.$in.map(String));
            }
            continue;
        }
        if (value === null) {
            clauses.push(`${column} IS NULL`);
            continue;
        }
        clauses.push(`${column} = ?`);
        params.push(value);
    }

    return { sql: ` WHERE ${clauses.join(' AND ')}`, params };
}

/** Maps one row back to the camelCase field names the tests read. */
function mapRow(spec, row) {
    if (!row) return null;
    const mapped = {};
    for (const [field, column] of Object.entries(spec.fields)) {
        mapped[field] = row[column];
    }
    return mapped;
}

/**
 * Translates a Mongoose sort spec (`{ _id: 1 }`, `{ email: -1 }`) into an ORDER BY list over
 * this table's real columns. Kept here rather than at each call site because the suite's sort
 * specs are written in API field names, not column names.
 */
function buildOrderBy(spec, sortSpec) {
    if (!sortSpec) {
        return 'id';
    }
    if (typeof sortSpec === 'string') {
        // `sort('field')` / `sort('-field')`
        const descending = sortSpec.startsWith('-');
        return buildOrderBy(spec, { [descending ? sortSpec.slice(1) : sortSpec]: descending ? -1 : 1 });
    }

    const parts = Object.entries(sortSpec).map(([field, direction]) => {
        const column = spec.fields[field];
        if (!column) {
            throw new Error(
                `tests/setup/tables.js: cannot sort ${spec.table} by "${field}" -- it is not a ` +
                'mapped field. Add it to the field map if a test needs it.'
            );
        }
        return `${column} ${Number(direction) < 0 ? 'DESC' : 'ASC'}`;
    });

    return parts.length > 0 ? parts.join(', ') : 'id';
}

/**
 * A thenable query object, so the assertions can keep the Mongoose chain shape they were
 * written in -- `find({}).sort({ _id: 1 }).lean()` -- while the work underneath is SQL.
 *
 * Nothing runs until the object is awaited, which is what makes the chain order irrelevant.
 *
 * - `sort(spec)` is real: it becomes the ORDER BY, and it matters, because several tests
 *   snapshot a table before and after a rejected request and compare the two arrays with
 *   `toEqual`. Without a deterministic order that comparison could fail on row order alone.
 * - `lean()` is a no-op: these rows are already plain objects, never hydrated documents.
 *   Kept so the call sites did not have to be edited, and because dropping it would have
 *   meant touching roughly fifty assertions for no behavioural gain.
 * - `select(...)` is a no-op for the same reason. Mongoose needed `select('+passwordHash')`
 *   because the field was `select: false` on the model; here the column is listed explicitly
 *   in the field map and is always returned, so there is nothing to opt into.
 */
class TableQuery {
    constructor(run) {
        this._run = run;
        this._sort = null;
    }

    sort(sortSpec) {
        this._sort = sortSpec;
        return this;
    }

    lean() {
        return this;
    }

    select() {
        return this;
    }

    then(onFulfilled, onRejected) {
        return this._run(this._sort).then(onFulfilled, onRejected);
    }

    catch(onRejected) {
        return this._run(this._sort).catch(onRejected);
    }

    finally(onFinally) {
        return this._run(this._sort).finally(onFinally);
    }
}

/**
 * Builds one accessor object per table.
 *
 * `find`, `findOne` and `findById` return a `TableQuery` rather than a bare promise, so the
 * suite's existing `.sort({ _id: 1 }).lean()` chains keep working. Ordering defaults to the
 * primary key when no `sort()` is given, so `find()` is stable either way -- which is what
 * lets a test compare two snapshots with `toEqual` and have the comparison mean something.
 *
 * `countDocuments` and `exists` return plain promises: nothing chains onto a count.
 */
function accessorFor(spec) {
    const columns = [...new Set(Object.values(spec.fields))].join(', ');

    return {
        /** @returns {TableQuery} awaitable; resolves to object[] */
        find(filter = {}) {
            return new TableQuery(async (sortSpec) => {
                const where = buildWhere(spec, filter);
                const rows = await query(
                    `SELECT ${columns} FROM ${spec.table}${where.sql} ` +
                    `ORDER BY ${buildOrderBy(spec, sortSpec)}`,
                    where.params
                );
                return rows.map((row) => mapRow(spec, row));
            });
        },

        /** @returns {TableQuery} awaitable; resolves to object|null */
        findOne(filter = {}) {
            return new TableQuery(async (sortSpec) => {
                const where = buildWhere(spec, filter);
                const rows = await query(
                    `SELECT ${columns} FROM ${spec.table}${where.sql} ` +
                    `ORDER BY ${buildOrderBy(spec, sortSpec)} LIMIT 1`,
                    where.params
                );
                return rows.length > 0 ? mapRow(spec, rows[0]) : null;
            });
        },

        /** @returns {TableQuery} awaitable; resolves to object|null */
        findById(id) {
            if (id === undefined || id === null) {
                return new TableQuery(async () => null);
            }
            return this.findOne({ id: String(id) });
        },

        /** @returns {Promise<number>} */
        async countDocuments(filter = {}) {
            const where = buildWhere(spec, filter);
            const rows = await query(
                `SELECT COUNT(*) AS n FROM ${spec.table}${where.sql}`,
                where.params
            );
            return rows[0].n;
        },

        /** @returns {Promise<boolean>} */
        async exists(filter = {}) {
            return (await this.countDocuments(filter)) > 0;
        },

        /**
         * Inserts one row, or an array of rows, and returns what was inserted with `_id`/`id`
         * filled in -- the shape the property tests read back (`String(created._id)`).
         *
         * An `_id`/`id` in the input is honoured, so a test may pin an id; otherwise one is
         * generated by src/db/id.js, exactly as the application does. Fields the input omits
         * are left to their column defaults rather than being written as NULL, which is what
         * lets `create({ item, location, batch, physicalQuantity })` land reserved_quantity
         * at 0 without saying so.
         *
         * Rows are inserted one statement at a time rather than as a multi-row INSERT: a
         * multi-row insert is all-or-nothing per statement, so one bad row in a generated
         * layout would hide which row was bad.
         *
         * @param {object|object[]} input
         * @returns {Promise<object|object[]>} matching the input's shape
         */
        async create(input) {
            const many = Array.isArray(input);
            const docs = many ? input : [input];
            const created = [];

            for (const doc of docs) {
                const id = String(doc._id ?? doc.id ?? newId());
                const assignments = [['id', id]];

                for (const [field, value] of Object.entries(doc)) {
                    if (field === '_id' || field === 'id' || value === undefined) continue;
                    const column = spec.fields[field];
                    if (!column) {
                        throw new Error(
                            `tests/setup/tables.js: cannot insert "${field}" into ${spec.table} ` +
                            '-- it is not a mapped field. Add it to the field map if a test needs it.'
                        );
                    }
                    assignments.push([column, value]);
                }

                await query(
                    `INSERT INTO ${spec.table} (${assignments.map(([c]) => c).join(', ')}) ` +
                    `VALUES (${assignments.map(() => '?').join(', ')})`,
                    assignments.map(([, value]) => value)
                );

                created.push(await this.findById(id));
            }

            return many ? created : created[0];
        },

        /**
         * Applies a `{ apiField: value }` patch to at most one matching row.
         *
         * @returns {Promise<{ matchedCount: number, modifiedCount: number }>}
         */
        async updateOne(filter = {}, patch = {}) {
            return runUpdate(spec, filter, patch, ' LIMIT 1');
        },

        /**
         * Applies a `{ apiField: value }` patch to every matching row. An empty filter
         * updates the whole table, matching Mongoose's behaviour.
         *
         * @returns {Promise<{ matchedCount: number, modifiedCount: number }>}
         */
        async updateMany(filter = {}, patch = {}) {
            return runUpdate(spec, filter, patch, '');
        },
    };
}

/** Shared body of `updateOne`/`updateMany`; they differ only by the LIMIT clause. */
async function runUpdate(spec, filter, patch, limit) {
    const assignments = [];
    const params = [];

    for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const column = spec.fields[field];
        if (!column) {
            throw new Error(
                `tests/setup/tables.js: cannot update "${field}" on ${spec.table} -- it is not ` +
                'a mapped field. Add it to the field map if a test needs it.'
            );
        }
        assignments.push(`${column} = ?`);
        params.push(value);
    }

    if (assignments.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    const where = buildWhere(spec, filter);
    const result = await query(
        `UPDATE ${spec.table} SET ${assignments.join(', ')}${where.sql}${limit}`,
        [...params, ...where.params]
    );

    // `affectedRows` counts rows the WHERE matched; `changedRows` counts those whose values
    // actually differ. Reported under the Mongoose names the tests would expect, though no
    // test reads them today -- an `await` on the promise is all any call site does.
    return { matchedCount: result.affectedRows, modifiedCount: result.changedRows };
}

module.exports = {
    User: accessorFor(TABLES.users),
    Category: accessorFor(TABLES.categories),
    Location: accessorFor(TABLES.locations),
    Item: accessorFor(TABLES.items),
    InventoryRecord: accessorFor(TABLES.inventoryRecords),
    InventoryTransaction: accessorFor(TABLES.inventoryTransactions),
    WorkOrder: accessorFor(TABLES.workOrders),
    InternalTransfer: accessorFor(TABLES.internalTransfers),
    CustomerOrder: accessorFor(TABLES.customerOrders),
    CustomerOrderReservation: accessorFor(TABLES.customerOrderReservations),
    TABLES,
};

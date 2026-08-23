// backend/src/openapi.js -- the OpenAPI 3.0 description of the API, served as raw
// JSON at GET /docs.json and nowhere else (see src/app.js), and read by
// scripts/postman.js to derive the tracked Postman collection under postman/.
// This is the machine-readable API-description artifact the case study brief asks
// for (spec plus generated collection); docs/api.md remains the prose reference.
//
// Two parts of this document are DERIVED rather than typed out, so they cannot
// drift from the code they describe:
//   - the error `code -> httpStatus` table comes from src/errors/errorCodes.js
//   - the permitted-role note on each write route comes from src/permissions.js
// The route list itself is asserted against the app's real router by
// tests/docs.test.js, so a route added without a spec entry fails the suite.

const ERROR_CODES = require('./errors/errorCodes');
const { WRITE_ROUTE_PERMISSIONS } = require('./permissions');

// --- helpers -------------------------------------------------------------------

/** The single `{ code, message }` envelope every error response uses (Req 9.5). */
const ERROR_REF = { $ref: '#/components/schemas/Error' };

/**
 * Builds one `responses` entry for an HTTP status, listing in its description
 * exactly which declared error codes can produce that status on this route.
 * The status is read from ERROR_CODES rather than repeated, so a code that
 * changes status updates every route that mentions it.
 *
 * @param {string[]} codes declared keys of ERROR_CODES
 */
function errorResponse(...codes) {
    const statuses = new Set(codes.map((code) => ERROR_CODES[code]));
    if (statuses.size !== 1) {
        // A programming error in this file, not a runtime concern: grouping codes
        // that do not share a status would silently document the wrong status.
        throw new Error(
            `errorResponse() expects codes sharing one status, received: ${codes.join(', ')}`
        );
    }

    return {
        description: codes.map((code) => `\`${code}\``).join(' / '),
        content: { 'application/json': { schema: ERROR_REF } },
    };
}

/** The role list a write route permits, as a sentence for its description. */
function rolesNote(routeKey) {
    const permitted = WRITE_ROUTE_PERMISSIONS[routeKey];
    if (!permitted) {
        throw new Error(`No WRITE_ROUTE_PERMISSIONS entry for "${routeKey}"`);
    }
    return `**Permitted roles:** ${permitted.map((role) => `\`${role}\``).join(', ')}.`;
}

const READ_ROLES_NOTE = '**Permitted roles:** any authenticated role.';

/** `{ id, ... }` reference objects the list responses embed. */
const objectId = (description) => ({
    type: 'string',
    pattern: '^[a-f0-9]{24}$',
    example: '6a8a5bff3cc5768dea0724a4',
    description,
});

// The spec is built at the bottom of this file, after every `const` helper below
// has been initialised -- `buildSpec()` is hoisted but the consts it reaches are
// not, so calling it here would throw a temporal-dead-zone ReferenceError.

function buildSpec() {
    return {
        openapi: '3.0.3',
        info: {
            title: 'Mini Operations ERP API',
            version: '1.0.0',
            description: [
                'Operations ERP covering Inventory → Work Order → Stock Check →',
                'Internal Transfer / Shortage → Customer Reservation.',
                '',
                'Every route except `POST /api/auth/login` requires a Bearer JWT.',
                'Reads are permitted for any authenticated role; writes are restricted',
                'by the role table in `src/permissions.js`, enforced server-side.',
            ].join('\n'),
        },
        servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
        tags: [
            { name: 'Authentication' },
            { name: 'Reference data' },
            { name: 'Inventory' },
            { name: 'Work Orders' },
            { name: 'Internal Transfers' },
            { name: 'Customer Orders' },
        ],
        security: [{ bearerAuth: [] }],
        components: components(),
        paths: paths(),
    };
}

// --- components ----------------------------------------------------------------

function components() {
    return {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                description:
                    'The `token` returned by `POST /api/auth/login`, sent as ' +
                    '`Authorization: Bearer <token>`. Expires 8 hours after issuance.',
            },
        },
        schemas: {
            Error: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                    code: {
                        type: 'string',
                        enum: Object.keys(ERROR_CODES),
                        description: 'A code from the declared table in `src/errors/errorCodes.js`.',
                    },
                    message: {
                        type: 'string',
                        description:
                            'Human-readable text carrying no stack trace, file path, ' +
                            'module name, or raw database text (Req 9.6, 9.7).',
                    },
                    details: {
                        type: 'array',
                        description: 'Present on `VALIDATION_ERROR` only: one entry per rejected field.',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string', example: 'quantity' },
                                reason: { type: 'string', example: 'must be a whole number' },
                            },
                        },
                    },
                },
            },

            CategoryRef: {
                type: 'object',
                properties: { id: objectId(), name: { type: 'string', example: 'Raw Material' } },
            },
            ItemRef: {
                type: 'object',
                properties: {
                    id: objectId(),
                    code: { type: 'string', example: 'ITM-1001' },
                    name: { type: 'string', example: 'Steel Bolt M8' },
                    category: { $ref: '#/components/schemas/CategoryRef' },
                },
            },
            LocationRef: {
                type: 'object',
                properties: {
                    id: objectId(),
                    code: { type: 'string', example: 'WH-MAIN' },
                    name: { type: 'string', example: 'Main Warehouse' },
                },
            },
            UserRef: {
                type: 'object',
                properties: {
                    id: objectId(),
                    email: { type: 'string', format: 'email', example: 'operations@mini-erp.local' },
                    role: { type: 'string', enum: ['Admin', 'OperationsUser', 'SalesUser'] },
                },
            },

            LoginRequest: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string', format: 'email', maxLength: 254, example: 'admin@mini-erp.local' },
                    password: { type: 'string', maxLength: 72, example: 'your-seed-password' },
                },
            },
            LoginResponse: {
                type: 'object',
                properties: {
                    token: { type: 'string', description: 'JWT valid for 8 hours.' },
                    user: {
                        type: 'object',
                        properties: {
                            id: objectId(),
                            email: { type: 'string', format: 'email' },
                            role: { type: 'string', enum: ['Admin', 'OperationsUser', 'SalesUser'] },
                            assignedLocation: {
                                ...objectId('The user\'s Location, or null when not site-bound.'),
                                nullable: true,
                            },
                        },
                    },
                },
            },

            InventoryRecord: {
                type: 'object',
                description:
                    '`availableQuantity` is derived as `physicalQuantity - reservedQuantity` ' +
                    'at read time and is never stored (Req 3.3).',
                properties: {
                    id: objectId(),
                    item: { $ref: '#/components/schemas/ItemRef' },
                    location: { $ref: '#/components/schemas/LocationRef' },
                    batch: { type: 'string', maxLength: 32, example: 'BATCH-001' },
                    physicalQuantity: { type: 'integer', minimum: 0, maximum: 999999999, example: 100 },
                    reservedQuantity: { type: 'integer', minimum: 0, maximum: 999999999, example: 30 },
                    availableQuantity: { type: 'integer', minimum: 0, example: 70 },
                },
            },
            CreateInventoryRecordRequest: {
                type: 'object',
                required: ['item', 'location', 'batch', 'physicalQuantity', 'movementReference'],
                properties: {
                    item: objectId('An existing Item.'),
                    location: objectId('An existing Location.'),
                    batch: { type: 'string', minLength: 1, maxLength: 32, example: 'BATCH-001' },
                    physicalQuantity: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 999999999,
                        description: 'Opening balance. May be 0 (Req 3.10).',
                        example: 50,
                    },
                    movementReference: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 200,
                        description: 'Idempotency key for the opening ledger row (Req 4.5).',
                        example: 'opening-2026-08-23-001',
                    },
                },
            },
            AdjustInventoryRecordRequest: {
                type: 'object',
                required: ['direction', 'quantity', 'movementReference'],
                properties: {
                    direction: { type: 'string', enum: ['IN', 'OUT'] },
                    quantity: { type: 'integer', minimum: 1, maximum: 1000000, example: 20 },
                    movementReference: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 200,
                        description:
                            'Idempotency key. Reusing a value is rejected with ' +
                            '`DUPLICATE_INVENTORY_TRANSACTION` (Req 4.5).',
                        example: 'adjust-2026-08-23-001',
                    },
                },
            },
            LocationAvailability: {
                type: 'object',
                description: 'Reports 0 rather than 404 when no record exists (Req 3.12).',
                properties: {
                    item: objectId(),
                    location: objectId(),
                    locationAvailableQuantity: { type: 'integer', minimum: 0, example: 50 },
                },
            },

            WorkOrder: {
                type: 'object',
                description:
                    '`shortageQuantity` is derived as `max(0, requiredQuantity - ' +
                    'locationAvailableQuantity)` at read time and is never stored (Req 5.4).',
                properties: {
                    id: objectId(),
                    location: { $ref: '#/components/schemas/LocationRef' },
                    item: { $ref: '#/components/schemas/ItemRef' },
                    requiredQuantity: { type: 'integer', minimum: 1, maximum: 1000000, example: 80 },
                    assignedUser: { $ref: '#/components/schemas/UserRef' },
                    status: { type: 'string', enum: ['Assigned', 'InProgress', 'Completed'] },
                    statusChangedAt: { type: 'string', format: 'date-time', nullable: true },
                    locationAvailableQuantity: { type: 'integer', minimum: 0, example: 50 },
                    shortageQuantity: { type: 'integer', minimum: 0, example: 30 },
                    createdAt: { type: 'string', format: 'date-time' },
                },
            },
            CreateWorkOrderRequest: {
                type: 'object',
                required: ['location', 'item', 'requiredQuantity', 'assignedUser'],
                properties: {
                    location: objectId('An existing Location.'),
                    item: objectId('An existing Item.'),
                    requiredQuantity: { type: 'integer', minimum: 1, maximum: 1000000, example: 80 },
                    assignedUser: objectId('An existing User.'),
                },
            },
            ChangeWorkOrderStatusRequest: {
                type: 'object',
                required: ['status'],
                properties: {
                    status: {
                        type: 'string',
                        enum: ['Assigned', 'InProgress', 'Completed'],
                        description:
                            'Accepted only when it is the immediate successor of the current ' +
                            'status, otherwise `INVALID_STATUS_TRANSITION` (Req 5.7).',
                    },
                },
            },
            WorkOrderStatusChanged: {
                type: 'object',
                properties: {
                    id: objectId(),
                    status: { type: 'string', enum: ['Assigned', 'InProgress', 'Completed'] },
                    statusChangedAt: { type: 'string', format: 'date-time', nullable: true },
                },
            },

            InternalTransfer: {
                type: 'object',
                properties: {
                    id: objectId(),
                    item: { $ref: '#/components/schemas/ItemRef' },
                    batch: { type: 'string', maxLength: 32, example: 'BATCH-001' },
                    sourceLocation: { $ref: '#/components/schemas/LocationRef' },
                    destinationLocation: { $ref: '#/components/schemas/LocationRef' },
                    quantity: { type: 'integer', minimum: 1, maximum: 1000000, example: 20 },
                    receivedQuantity: {
                        type: 'integer',
                        minimum: 0,
                        description: '0 until the transfer is received, then equal to `quantity`.',
                        example: 0,
                    },
                    status: { type: 'string', enum: ['Requested', 'Dispatched', 'Received'] },
                    createdAt: { type: 'string', format: 'date-time' },
                    dispatchedAt: { type: 'string', format: 'date-time', nullable: true },
                    receivedAt: { type: 'string', format: 'date-time', nullable: true },
                },
            },
            CreateTransferRequest: {
                type: 'object',
                required: ['item', 'batch', 'sourceLocation', 'destinationLocation', 'quantity'],
                properties: {
                    item: objectId('An existing Item.'),
                    batch: { type: 'string', minLength: 1, maxLength: 32, example: 'BATCH-001' },
                    sourceLocation: objectId('Must differ from destinationLocation.'),
                    destinationLocation: objectId('Must differ from sourceLocation.'),
                    quantity: { type: 'integer', minimum: 1, maximum: 1000000, example: 20 },
                },
            },

            ReservationEntry: {
                type: 'object',
                description: 'One batch the order drew from, in ascending batch order (Req 15.6).',
                properties: {
                    item: objectId(),
                    location: objectId(),
                    batch: { type: 'string', example: 'BATCH-001' },
                    quantity: { type: 'integer', minimum: 1, example: 60 },
                },
            },
            CustomerOrder: {
                type: 'object',
                properties: {
                    id: objectId(),
                    customerName: { type: 'string', minLength: 1, maxLength: 120, example: 'Acme Corp' },
                    item: { $ref: '#/components/schemas/ItemRef' },
                    location: { $ref: '#/components/schemas/LocationRef' },
                    quantity: { type: 'integer', minimum: 1, maximum: 1000000, example: 60 },
                    status: { type: 'string', enum: ['Reserved', 'Cancelled'] },
                    reservations: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 20,
                        items: { $ref: '#/components/schemas/ReservationEntry' },
                    },
                    createdAt: { type: 'string', format: 'date-time' },
                },
            },
            CreateOrderRequest: {
                type: 'object',
                required: ['customerName', 'item', 'location', 'quantity'],
                properties: {
                    customerName: { type: 'string', minLength: 1, maxLength: 120, example: 'Acme Corp' },
                    item: objectId('An existing Item.'),
                    location: objectId('An existing Location.'),
                    quantity: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 1000000,
                        description:
                            'Rejected with `INSUFFICIENT_AVAILABLE_QUANTITY` when it exceeds ' +
                            'the availability of the item at the location (Req 7.3).',
                        example: 60,
                    },
                },
            },
        },
    };
}

// --- paths ---------------------------------------------------------------------
// Path keys use OpenAPI's `{id}` placeholder; tests/docs.test.js converts them to
// Express's `:id` before comparing against the app's declared route table.

const ID_PARAM = {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', pattern: '^[a-f0-9]{24}$' },
    description: 'A 24-character hexadecimal identifier.',
};

const arrayOf = (schemaName) => ({
    description: 'Success',
    content: {
        'application/json': {
            schema: { type: 'array', items: { $ref: `#/components/schemas/${schemaName}` } },
        },
    },
});

const objectOf = (schemaName, description = 'Success') => ({
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const jsonBody = (schemaName) => ({
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

/** Every authenticated route can answer 401 when the token is missing or invalid. */
const UNAUTHENTICATED = errorResponse('UNAUTHENTICATED');

function paths() {
    return {
        '/api/auth/login': {
            post: {
                tags: ['Authentication'],
                summary: 'Exchange credentials for a JWT',
                description:
                    '**Permitted roles:** public — no token required.\n\n' +
                    'An unmatched email and a wrong password return an identical response, ' +
                    'so email existence cannot be probed (Req 1.4).',
                security: [],
                requestBody: jsonBody('LoginRequest'),
                responses: {
                    200: objectOf('LoginResponse'),
                    400: errorResponse('VALIDATION_ERROR', 'MALFORMED_JSON'),
                    401: errorResponse('INVALID_CREDENTIALS'),
                },
            },
        },

        '/api/items': {
            get: {
                tags: ['Reference data'],
                summary: 'List items with their category',
                description: `${READ_ROLES_NOTE}\n\nSorted by item code.`,
                responses: { 200: arrayOf('ItemRef'), 401: UNAUTHENTICATED },
            },
        },
        '/api/locations': {
            get: {
                tags: ['Reference data'],
                summary: 'List locations',
                description: `${READ_ROLES_NOTE}\n\nSorted by location code.`,
                responses: { 200: arrayOf('LocationRef'), 401: UNAUTHENTICATED },
            },
        },
        '/api/users': {
            get: {
                tags: ['Reference data'],
                summary: 'List users (id, email, role only)',
                description: `${READ_ROLES_NOTE}\n\nNever exposes \`passwordHash\` (Req 1.1).`,
                responses: { 200: arrayOf('UserRef'), 401: UNAUTHENTICATED },
            },
        },

        '/api/inventory': {
            get: {
                tags: ['Inventory'],
                summary: 'List inventory records',
                description: READ_ROLES_NOTE,
                parameters: [
                    { name: 'item', in: 'query', required: false, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
                    { name: 'location', in: 'query', required: false, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
                ],
                responses: {
                    200: arrayOf('InventoryRecord'),
                    400: errorResponse('INVALID_IDENTIFIER'),
                    401: UNAUTHENTICATED,
                },
            },
            post: {
                tags: ['Inventory'],
                summary: 'Create an inventory record with an opening balance',
                description:
                    `${rolesNote('POST /api/inventory')}\n\n` +
                    'Writes the record and its opening ledger row in one transaction (Req 4.4).',
                requestBody: jsonBody('CreateInventoryRecordRequest'),
                responses: {
                    201: objectOf('InventoryRecord', 'Created'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_QUANTITY', 'INVALID_REFERENCE', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                    409: errorResponse('DUPLICATE_INVENTORY_RECORD', 'DUPLICATE_INVENTORY_TRANSACTION', 'CONCURRENT_MODIFICATION'),
                },
            },
        },
        '/api/inventory/availability': {
            get: {
                tags: ['Inventory'],
                summary: 'Read total available quantity of an item at a location',
                description: `${READ_ROLES_NOTE}\n\nBoth query parameters are required.`,
                parameters: [
                    { name: 'item', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
                    { name: 'location', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
                ],
                responses: {
                    200: objectOf('LocationAvailability'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_IDENTIFIER'),
                    401: UNAUTHENTICATED,
                },
            },
        },
        '/api/inventory/{id}/adjust': {
            post: {
                tags: ['Inventory'],
                summary: 'Apply an IN or OUT movement to a record',
                description:
                    `${rolesNote('POST /api/inventory/:id/adjust')}\n\n` +
                    'Rejected when the movement would drive physical below 0 or reserved ' +
                    'above physical (Req 3.8, 3.9).',
                parameters: [ID_PARAM],
                requestBody: jsonBody('AdjustInventoryRecordRequest'),
                responses: {
                    200: objectOf('InventoryRecord'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_QUANTITY', 'INVALID_IDENTIFIER', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                    404: errorResponse('NOT_FOUND'),
                    409: errorResponse('INSUFFICIENT_PHYSICAL_QUANTITY', 'INSUFFICIENT_AVAILABLE_QUANTITY', 'DUPLICATE_INVENTORY_TRANSACTION', 'CONCURRENT_MODIFICATION'),
                },
            },
        },

        '/api/work-orders': {
            get: {
                tags: ['Work Orders'],
                summary: 'List work orders with derived shortage',
                description: READ_ROLES_NOTE,
                parameters: [
                    { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['Assigned', 'InProgress', 'Completed'] } },
                    { name: 'location', in: 'query', required: false, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } },
                ],
                responses: {
                    200: arrayOf('WorkOrder'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_IDENTIFIER'),
                    401: UNAUTHENTICATED,
                },
            },
            post: {
                tags: ['Work Orders'],
                summary: 'Create a work order',
                description: `${rolesNote('POST /api/work-orders')}\n\nStatus starts at \`Assigned\`.`,
                requestBody: jsonBody('CreateWorkOrderRequest'),
                responses: {
                    201: objectOf('WorkOrder', 'Created'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_QUANTITY', 'INVALID_REFERENCE', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                },
            },
        },
        '/api/work-orders/{id}': {
            get: {
                tags: ['Work Orders'],
                summary: 'Read one work order',
                description: READ_ROLES_NOTE,
                parameters: [ID_PARAM],
                responses: {
                    200: objectOf('WorkOrder'),
                    400: errorResponse('INVALID_IDENTIFIER'),
                    401: UNAUTHENTICATED,
                    404: errorResponse('NOT_FOUND'),
                },
            },
        },
        '/api/work-orders/{id}/status': {
            patch: {
                tags: ['Work Orders'],
                summary: 'Advance work order status',
                description:
                    `${rolesNote('PATCH /api/work-orders/:id/status')}\n\n` +
                    'Accepts only the immediate successor: `Assigned` → `InProgress` → `Completed`.',
                parameters: [ID_PARAM],
                requestBody: jsonBody('ChangeWorkOrderStatusRequest'),
                responses: {
                    200: objectOf('WorkOrderStatusChanged'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_IDENTIFIER', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                    404: errorResponse('NOT_FOUND'),
                    409: errorResponse('INVALID_STATUS_TRANSITION'),
                },
            },
        },

        '/api/transfers': {
            get: {
                tags: ['Internal Transfers'],
                summary: 'List internal transfers',
                description: READ_ROLES_NOTE,
                parameters: [
                    { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['Requested', 'Dispatched', 'Received'] } },
                ],
                responses: {
                    200: arrayOf('InternalTransfer'),
                    400: errorResponse('VALIDATION_ERROR'),
                    401: UNAUTHENTICATED,
                },
            },
            post: {
                tags: ['Internal Transfers'],
                summary: 'Request a transfer between two locations',
                description:
                    `${rolesNote('POST /api/transfers')}\n\n` +
                    'Writes no inventory: status starts at `Requested` and stock moves only ' +
                    'on dispatch and receipt (Req 6.3).',
                requestBody: jsonBody('CreateTransferRequest'),
                responses: {
                    201: objectOf('InternalTransfer', 'Created'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_QUANTITY', 'INVALID_REFERENCE', 'SAME_LOCATION_TRANSFER', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                },
            },
        },
        '/api/transfers/{id}/dispatch': {
            post: {
                tags: ['Internal Transfers'],
                summary: 'Dispatch a requested transfer, reducing source stock',
                description:
                    `${rolesNote('POST /api/transfers/:id/dispatch')}\n\n` +
                    'Reduces the source record only. The destination is untouched until ' +
                    'receipt (Req 6.6).',
                parameters: [ID_PARAM],
                responses: {
                    200: objectOf('InternalTransfer'),
                    400: errorResponse('INVALID_IDENTIFIER', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                    404: errorResponse('NOT_FOUND'),
                    409: errorResponse('INSUFFICIENT_AVAILABLE_QUANTITY', 'INVALID_STATUS_TRANSITION', 'DUPLICATE_INVENTORY_TRANSACTION', 'CONCURRENT_MODIFICATION'),
                },
            },
        },
        '/api/transfers/{id}/receive': {
            post: {
                tags: ['Internal Transfers'],
                summary: 'Receive a dispatched transfer, increasing destination stock',
                description:
                    `${rolesNote('POST /api/transfers/:id/receive')}\n\n` +
                    'Creates the destination record when none exists. A second receipt is ' +
                    'rejected with `TRANSFER_ALREADY_RECEIVED` (Req 6.9).',
                parameters: [ID_PARAM],
                responses: {
                    200: objectOf('InternalTransfer'),
                    400: errorResponse('INVALID_IDENTIFIER', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                    404: errorResponse('NOT_FOUND'),
                    409: errorResponse('TRANSFER_ALREADY_RECEIVED', 'INVALID_STATUS_TRANSITION', 'CONCURRENT_MODIFICATION'),
                },
            },
        },

        '/api/orders': {
            get: {
                tags: ['Customer Orders'],
                summary: 'List customer orders with their reservations',
                description: READ_ROLES_NOTE,
                parameters: [
                    { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['Reserved', 'Cancelled'] } },
                ],
                responses: {
                    200: arrayOf('CustomerOrder'),
                    400: errorResponse('VALIDATION_ERROR'),
                    401: UNAUTHENTICATED,
                },
            },
            post: {
                tags: ['Customer Orders'],
                summary: 'Create an order, reserving stock across batches',
                description:
                    `${rolesNote('POST /api/orders')}\n\n` +
                    'Reserves in ascending batch order inside one transaction. Two concurrent ' +
                    'requests whose sum exceeds availability cannot both succeed (Req 7.5–7.7).',
                requestBody: jsonBody('CreateOrderRequest'),
                responses: {
                    201: objectOf('CustomerOrder', 'Created'),
                    400: errorResponse('VALIDATION_ERROR', 'INVALID_QUANTITY', 'INVALID_REFERENCE', 'MALFORMED_JSON'),
                    401: UNAUTHENTICATED,
                    403: errorResponse('FORBIDDEN'),
                    409: errorResponse('INSUFFICIENT_AVAILABLE_QUANTITY', 'CONCURRENT_MODIFICATION'),
                },
            },
        },
        '/api/orders/{id}': {
            get: {
                tags: ['Customer Orders'],
                summary: 'Read one customer order',
                description: READ_ROLES_NOTE,
                parameters: [ID_PARAM],
                responses: {
                    200: objectOf('CustomerOrder'),
                    400: errorResponse('INVALID_IDENTIFIER'),
                    401: UNAUTHENTICATED,
                    404: errorResponse('NOT_FOUND'),
                },
            },
        },
    };
}

// Built once at require time, after every helper above is initialised.
module.exports = buildSpec();

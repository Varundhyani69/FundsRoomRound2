# API Documentation

This document lists every route the API_Server exposes, exactly as declared in
`backend/src/routes/`. It is generated from the source, not from the design plan, so a
mismatch between this document and the code is a bug in this document (Req 13.3, 13.9).

## Conventions

- Base path: every route below is mounted under `/api` (see `backend/src/routes/index.js`).
- Authentication: every route except `POST /api/auth/login` requires an
  `Authorization: Bearer <token>` header carrying a JSON Web Token issued by the login route.
  A missing, undecodable, badly signed, or expired token is rejected with `401 UNAUTHENTICATED`
  before any route handler runs.
- Authorization: every authenticated route also passes through the authorization middleware.
  A token carrying a role outside `Admin`, `OperationsUser`, `SalesUser` is rejected with
  `403 FORBIDDEN` on any route. Beyond that, read routes (`GET`) accept any of the three roles;
  write routes (`POST`, `PATCH`) accept only the role set named in
  `backend/src/permissions.js`, listed per route below as "Permitted roles".
- Request bodies are validated with `.strict()` zod schemas: a field not named by the schema
  is rejected with `400 VALIDATION_ERROR`, not silently ignored.
- All example values below (ids, emails, tokens, names) are illustrative placeholders, not
  real data or credentials.
- All ids in examples are 24-character hexadecimal strings, the same shape a MongoDB
  `ObjectId` serializes to.

---

## 1. Authentication

### `POST /api/auth/login`

**Permitted roles:** public — no token required.

**Request body:**

| Field    | Type   | Constraints                                    |
|----------|--------|-------------------------------------------------|
| email    | string | required, trimmed, lowercased, 1–254 characters |
| password | string | required, trimmed, 1–72 characters              |

No other field is accepted.

**Success response:** `200 OK`

```json
{
  "token": "string",
  "user": {
    "id": "string",
    "email": "string",
    "role": "Admin | OperationsUser | SalesUser",
    "assignedLocation": "string | null"
  }
}
```

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| VALIDATION_ERROR     | 400         | Email or password missing, blank, or over the length limit |
| INVALID_CREDENTIALS  | 401         | Email matches no user, or the password does not match the stored hash |

**Example request:**

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "ExamplePassw0rd!"
}
```

**Example response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example-payload.example-signature",
  "user": {
    "id": "65a1f0c8e4b0a1c2d3e4f5c1",
    "email": "admin@example.com",
    "role": "Admin",
    "assignedLocation": null
  }
}
```

---

## 2. Reference Data

Items, Locations, and Users are read-only lists used to populate form dropdowns. Any
authenticated role may call them.

### `GET /api/items`

**Permitted roles:** any authenticated role.

**Request schema:** no path params, no query params, no body.

**Success response:** `200 OK`

```json
[
  {
    "id": "string",
    "code": "string",
    "name": "string",
    "category": { "id": "string", "name": "string" } | null
  }
]
```

**Errors:**

| Code            | HTTP Status | When |
|------------------|-------------|------|
| UNAUTHENTICATED  | 401         | No valid token supplied |
| FORBIDDEN        | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/items
Authorization: Bearer <token>
```

**Example response:**

```json
[
  {
    "id": "65a1f0c8e4b0a1c2d3e4f5a1",
    "code": "SKU-001",
    "name": "Widget",
    "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
  }
]
```

### `GET /api/locations`

**Permitted roles:** any authenticated role.

**Request schema:** no path params, no query params, no body.

**Success response:** `200 OK`

```json
[
  { "id": "string", "code": "string", "name": "string" }
]
```

**Errors:**

| Code            | HTTP Status | When |
|------------------|-------------|------|
| UNAUTHENTICATED  | 401         | No valid token supplied |
| FORBIDDEN        | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/locations
Authorization: Bearer <token>
```

**Example response:**

```json
[
  { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" }
]
```

### `GET /api/users`

**Permitted roles:** any authenticated role.

**Request schema:** no path params, no query params, no body.

**Success response:** `200 OK`

```json
[
  { "id": "string", "email": "string", "role": "Admin | OperationsUser | SalesUser" }
]
```

**Errors:**

| Code            | HTTP Status | When |
|------------------|-------------|------|
| UNAUTHENTICATED  | 401         | No valid token supplied |
| FORBIDDEN        | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/users
Authorization: Bearer <token>
```

**Example response:**

```json
[
  { "id": "65a1f0c8e4b0a1c2d3e4f5c2", "email": "ops@example.com", "role": "OperationsUser" }
]
```

---

## 3. Inventory

Every inventory record response uses this shape:

```json
{
  "id": "string",
  "item": {
    "id": "string",
    "code": "string",
    "name": "string",
    "category": { "id": "string", "name": "string" }
  },
  "location": { "id": "string", "code": "string", "name": "string" },
  "batch": "string",
  "physicalQuantity": 0,
  "reservedQuantity": 0,
  "availableQuantity": 0
}
```

### `GET /api/inventory`

**Permitted roles:** any authenticated role.

**Request schema — query params (all optional):**

| Field    | Type   | Constraints                              |
|----------|--------|-------------------------------------------|
| item     | string | 24-character hexadecimal identifier       |
| location | string | 24-character hexadecimal identifier       |

**Success response:** `200 OK` — array of the inventory record shape above.

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| INVALID_IDENTIFIER   | 400         | `item` or `location` query value is not a 24-character hex string |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/inventory?item=65a1f0c8e4b0a1c2d3e4f5a1&location=65a1f0c8e4b0a1c2d3e4f5d1
Authorization: Bearer <token>
```

**Example response:**

```json
[
  {
    "id": "65a1f0c8e4b0a1c2d3e4f5e1",
    "item": {
      "id": "65a1f0c8e4b0a1c2d3e4f5a1",
      "code": "SKU-001",
      "name": "Widget",
      "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
    },
    "location": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
    "batch": "BATCH-A",
    "physicalQuantity": 100,
    "reservedQuantity": 30,
    "availableQuantity": 70
  }
]
```

### `GET /api/inventory/availability`

**Permitted roles:** any authenticated role.

**Request schema — query params (both required):**

| Field    | Type   | Constraints                              |
|----------|--------|--------------------------------------------|
| item     | string | required, 24-character hexadecimal identifier |
| location | string | required, 24-character hexadecimal identifier |

**Success response:** `200 OK`

```json
{ "item": "string", "location": "string", "locationAvailableQuantity": 0 }
```

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| VALIDATION_ERROR     | 400         | `item` or `location` is missing |
| INVALID_IDENTIFIER   | 400         | `item` or `location` is not a 24-character hex string |
| INVALID_REFERENCE    | 400         | `item` or `location` does not match an existing document |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/inventory/availability?item=65a1f0c8e4b0a1c2d3e4f5a1&location=65a1f0c8e4b0a1c2d3e4f5d1
Authorization: Bearer <token>
```

**Example response:**

```json
{
  "item": "65a1f0c8e4b0a1c2d3e4f5a1",
  "location": "65a1f0c8e4b0a1c2d3e4f5d1",
  "locationAvailableQuantity": 70
}
```

### `POST /api/inventory`

**Permitted roles:** `Admin`, `OperationsUser`.

**Request body:**

| Field             | Type   | Constraints |
|-------------------|--------|--------------|
| item              | string | required, 24-character hexadecimal identifier, must reference an existing Item |
| location          | string | required, 24-character hexadecimal identifier, must reference an existing Location |
| batch             | string | required, trimmed, 1–32 characters |
| physicalQuantity  | number | required, integer, 0–999,999,999 (opening balance) |
| movementReference | string | required, non-blank, at most 200 characters |

No other field is accepted.

**Success response:** `201 Created` — the inventory record shape shown above, with
`reservedQuantity: 0` and `availableQuantity` equal to `physicalQuantity`.

**Errors:**

| Code                            | HTTP Status | When |
|-----------------------------------|-------------|------|
| VALIDATION_ERROR                 | 400         | A field is missing, blank, over-length, or not a whole number in the starting-quantity range |
| INVALID_REFERENCE                | 400         | `item` or `location` does not match an existing document |
| UNAUTHENTICATED                  | 401         | No valid token supplied |
| FORBIDDEN                        | 403         | Token role is neither `Admin` nor `OperationsUser` |
| DUPLICATE_INVENTORY_RECORD       | 409         | An inventory record for this item, location, and batch already exists |
| DUPLICATE_INVENTORY_TRANSACTION  | 409         | The opening movement reference has already been applied |

**Example request:**

```http
POST /api/inventory
Authorization: Bearer <token>
Content-Type: application/json

{
  "item": "65a1f0c8e4b0a1c2d3e4f5a1",
  "location": "65a1f0c8e4b0a1c2d3e4f5d1",
  "batch": "BATCH-A",
  "physicalQuantity": 100,
  "movementReference": "receipt-2024-05-01"
}
```

**Example response:**

```json
{
  "id": "65a1f0c8e4b0a1c2d3e4f5e1",
  "item": {
    "id": "65a1f0c8e4b0a1c2d3e4f5a1",
    "code": "SKU-001",
    "name": "Widget",
    "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
  },
  "location": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
  "batch": "BATCH-A",
  "physicalQuantity": 100,
  "reservedQuantity": 0,
  "availableQuantity": 100
}
```

### `POST /api/inventory/:id/adjust`

**Permitted roles:** `Admin`, `OperationsUser`.

**Request schema — path params:**

| Field | Type   | Constraints |
|-------|--------|--------------|
| id    | string | required, 24-character hexadecimal identifier |

**Request body:**

| Field             | Type   | Constraints |
|-------------------|--------|--------------|
| direction         | string | required, one of `IN`, `OUT` |
| quantity          | number | required, integer, 1–1,000,000 |
| movementReference | string | required, non-blank, at most 200 characters |

No other field is accepted.

**Success response:** `200 OK` — the inventory record shape shown above, reflecting the
applied adjustment.

**Errors:**

| Code                                 | HTTP Status | When |
|---------------------------------------|-------------|------|
| VALIDATION_ERROR                     | 400         | `direction` or `movementReference` is missing, blank, or not one of the allowed values |
| INVALID_QUANTITY                     | 400         | `quantity` is not an integer from 1 to 1,000,000 |
| INVALID_IDENTIFIER                   | 400         | `:id` is not a 24-character hex string |
| UNAUTHENTICATED                      | 401         | No valid token supplied |
| FORBIDDEN                            | 403         | Token role is neither `Admin` nor `OperationsUser` |
| NOT_FOUND                            | 404         | No inventory record matches `:id` |
| INSUFFICIENT_PHYSICAL_QUANTITY       | 409         | An `OUT` adjustment would set physical quantity below 0 |
| INSUFFICIENT_AVAILABLE_QUANTITY      | 409         | The adjustment would set reserved quantity above physical quantity |
| DUPLICATE_INVENTORY_TRANSACTION      | 409         | The movement reference has already been applied to this record |

**Example request:**

```http
POST /api/inventory/65a1f0c8e4b0a1c2d3e4f5e1/adjust
Authorization: Bearer <token>
Content-Type: application/json

{
  "direction": "OUT",
  "quantity": 30,
  "movementReference": "cycle-count-2024-05-02"
}
```

**Example response:**

```json
{
  "id": "65a1f0c8e4b0a1c2d3e4f5e1",
  "item": {
    "id": "65a1f0c8e4b0a1c2d3e4f5a1",
    "code": "SKU-001",
    "name": "Widget",
    "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
  },
  "location": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
  "batch": "BATCH-A",
  "physicalQuantity": 70,
  "reservedQuantity": 0,
  "availableQuantity": 70
}
```

---

## 4. Work Orders

Every work order response uses this shape:

```json
{
  "id": "string",
  "location": { "id": "string", "code": "string", "name": "string" },
  "item": {
    "id": "string",
    "code": "string",
    "name": "string",
    "category": { "id": "string", "name": "string" }
  },
  "requiredQuantity": 0,
  "assignedUser": { "id": "string", "email": "string", "role": "string" },
  "status": "Assigned | InProgress | Completed",
  "statusChangedAt": "string | null",
  "locationAvailableQuantity": 0,
  "shortageQuantity": 0,
  "createdAt": "string"
}
```

### `GET /api/work-orders`

**Permitted roles:** any authenticated role.

**Request schema — query params (both optional):**

| Field    | Type   | Constraints |
|----------|--------|--------------|
| status   | string | one of `Assigned`, `InProgress`, `Completed` |
| location | string | 24-character hexadecimal identifier |

**Success response:** `200 OK` — array of the work order shape above.

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| VALIDATION_ERROR     | 400         | `status` is not one of the three allowed values |
| INVALID_IDENTIFIER   | 400         | `location` is not a 24-character hex string |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/work-orders?status=Assigned
Authorization: Bearer <token>
```

**Example response:**

```json
[
  {
    "id": "65a1f0c8e4b0a1c2d3e4f5f1",
    "location": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
    "item": {
      "id": "65a1f0c8e4b0a1c2d3e4f5a1",
      "code": "SKU-001",
      "name": "Widget",
      "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
    },
    "requiredQuantity": 100,
    "assignedUser": { "id": "65a1f0c8e4b0a1c2d3e4f5c2", "email": "ops@example.com", "role": "OperationsUser" },
    "status": "Assigned",
    "statusChangedAt": null,
    "locationAvailableQuantity": 60,
    "shortageQuantity": 40,
    "createdAt": "2024-05-01T12:00:00.000Z"
  }
]
```

### `GET /api/work-orders/:id`

**Permitted roles:** any authenticated role.

**Request schema — path params:**

| Field | Type   | Constraints |
|-------|--------|--------------|
| id    | string | required, 24-character hexadecimal identifier |

**Success response:** `200 OK` — single object of the work order shape above.

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| INVALID_IDENTIFIER   | 400         | `:id` is not a 24-character hex string |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not one of the three declared roles |
| NOT_FOUND            | 404         | No work order matches `:id` |

**Example request:**

```http
GET /api/work-orders/65a1f0c8e4b0a1c2d3e4f5f1
Authorization: Bearer <token>
```

**Example response:** same shape as the list example above, as a single object.

### `POST /api/work-orders`

**Permitted roles:** `Admin`.

**Request body:**

| Field             | Type   | Constraints |
|-------------------|--------|--------------|
| location          | string | required, 24-character hexadecimal identifier, must reference an existing Location |
| item              | string | required, 24-character hexadecimal identifier, must reference an existing Item |
| requiredQuantity  | number | required, integer, 1–1,000,000 |
| assignedUser      | string | required, 24-character hexadecimal identifier, must reference an existing User |

No other field is accepted.

**Success response:** `201 Created` — the work order shape above, with `status: "Assigned"`.

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| VALIDATION_ERROR     | 400         | A required field is missing, or an id field is not a string |
| INVALID_QUANTITY     | 400         | `requiredQuantity` is not an integer from 1 to 1,000,000 |
| INVALID_REFERENCE    | 400         | `location`, `item`, or `assignedUser` does not match an existing document |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not `Admin` |

**Example request:**

```http
POST /api/work-orders
Authorization: Bearer <token>
Content-Type: application/json

{
  "location": "65a1f0c8e4b0a1c2d3e4f5d1",
  "item": "65a1f0c8e4b0a1c2d3e4f5a1",
  "requiredQuantity": 100,
  "assignedUser": "65a1f0c8e4b0a1c2d3e4f5c2"
}
```

**Example response:** same shape as the `GET /api/work-orders/:id` example above.

### `PATCH /api/work-orders/:id/status`

**Permitted roles:** `Admin`, `OperationsUser`.

**Request schema — path params:**

| Field | Type   | Constraints |
|-------|--------|--------------|
| id    | string | required, 24-character hexadecimal identifier |

**Request body:**

| Field  | Type   | Constraints |
|--------|--------|--------------|
| status | string | required, one of `Assigned`, `InProgress`, `Completed` |

No other field is accepted.

**Success response:** `200 OK`

```json
{ "id": "string", "status": "Assigned | InProgress | Completed", "statusChangedAt": "string" }
```

**Errors:**

| Code                        | HTTP Status | When |
|------------------------------|-------------|------|
| VALIDATION_ERROR            | 400         | `status` is not one of the three allowed values |
| INVALID_IDENTIFIER          | 400         | `:id` is not a 24-character hex string |
| UNAUTHENTICATED             | 401         | No valid token supplied |
| FORBIDDEN                   | 403         | Token role is neither `Admin` nor `OperationsUser` |
| NOT_FOUND                   | 404         | No work order matches `:id` |
| INVALID_STATUS_TRANSITION   | 409         | `status` is not the immediate successor of the work order's current status |

**Example request:**

```http
PATCH /api/work-orders/65a1f0c8e4b0a1c2d3e4f5f1/status
Authorization: Bearer <token>
Content-Type: application/json

{ "status": "InProgress" }
```

**Example response:**

```json
{
  "id": "65a1f0c8e4b0a1c2d3e4f5f1",
  "status": "InProgress",
  "statusChangedAt": "2024-05-01T13:00:00.000Z"
}
```

---

## 5. Internal Transfers

Every internal transfer response uses this shape:

```json
{
  "id": "string",
  "item": {
    "id": "string",
    "code": "string",
    "name": "string",
    "category": { "id": "string", "name": "string" }
  },
  "batch": "string",
  "sourceLocation": { "id": "string", "code": "string", "name": "string" },
  "destinationLocation": { "id": "string", "code": "string", "name": "string" },
  "quantity": 0,
  "receivedQuantity": 0,
  "status": "Requested | Dispatched | Received",
  "createdAt": "string",
  "dispatchedAt": "string | null",
  "receivedAt": "string | null"
}
```

### `GET /api/transfers`

**Permitted roles:** any authenticated role.

**Request schema — query params (optional):**

| Field  | Type   | Constraints |
|--------|--------|--------------|
| status | string | one of `Requested`, `Dispatched`, `Received` |

**Success response:** `200 OK` — array of the internal transfer shape above.

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| VALIDATION_ERROR     | 400         | `status` is not one of the three allowed values |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/transfers?status=Requested
Authorization: Bearer <token>
```

**Example response:**

```json
[
  {
    "id": "65a1f0c8e4b0a1c2d3e4f601",
    "item": {
      "id": "65a1f0c8e4b0a1c2d3e4f5a1",
      "code": "SKU-001",
      "name": "Widget",
      "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
    },
    "batch": "BATCH-A",
    "sourceLocation": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
    "destinationLocation": { "id": "65a1f0c8e4b0a1c2d3e4f5d2", "code": "WH-02", "name": "Secondary Warehouse" },
    "quantity": 20,
    "receivedQuantity": 0,
    "status": "Requested",
    "createdAt": "2024-05-01T14:00:00.000Z",
    "dispatchedAt": null,
    "receivedAt": null
  }
]
```

### `POST /api/transfers`

**Permitted roles:** `Admin`, `OperationsUser`.

**Request body:**

| Field                | Type   | Constraints |
|----------------------|--------|--------------|
| item                 | string | required, 24-character hexadecimal identifier, must reference an existing Item |
| batch                | string | required, trimmed, 1–32 characters, must have an existing inventory record at `sourceLocation` |
| sourceLocation       | string | required, 24-character hexadecimal identifier, must reference an existing Location |
| destinationLocation  | string | required, 24-character hexadecimal identifier, must reference an existing Location, must differ from `sourceLocation` |
| quantity             | number | required, integer, 1–1,000,000 |

No other field is accepted.

**Success response:** `201 Created` — the internal transfer shape above, with
`status: "Requested"` and `receivedQuantity: 0`.

**Errors:**

| Code                    | HTTP Status | When |
|--------------------------|-------------|------|
| VALIDATION_ERROR         | 400         | A field is missing, blank, or over-length |
| INVALID_QUANTITY         | 400         | `quantity` is not an integer from 1 to 1,000,000 |
| INVALID_REFERENCE        | 400         | `item`, `sourceLocation`, or `destinationLocation` does not exist, or no inventory record exists for `item`/`sourceLocation`/`batch` |
| SAME_LOCATION_TRANSFER   | 400         | `destinationLocation` equals `sourceLocation` |
| UNAUTHENTICATED          | 401         | No valid token supplied |
| FORBIDDEN                | 403         | Token role is neither `Admin` nor `OperationsUser` |

**Example request:**

```http
POST /api/transfers
Authorization: Bearer <token>
Content-Type: application/json

{
  "item": "65a1f0c8e4b0a1c2d3e4f5a1",
  "batch": "BATCH-A",
  "sourceLocation": "65a1f0c8e4b0a1c2d3e4f5d1",
  "destinationLocation": "65a1f0c8e4b0a1c2d3e4f5d2",
  "quantity": 20
}
```

**Example response:** same shape as the `GET /api/transfers` example above.

### `POST /api/transfers/:id/dispatch`

**Permitted roles:** `Admin`, `OperationsUser`.

**Request schema — path params:**

| Field | Type   | Constraints |
|-------|--------|--------------|
| id    | string | required, 24-character hexadecimal identifier |

**Request body:** none accepted (empty object only).

**Success response:** `200 OK` — the internal transfer shape above, with
`status: "Dispatched"` and `dispatchedAt` set.

**Errors:**

| Code                                 | HTTP Status | When |
|---------------------------------------|-------------|------|
| VALIDATION_ERROR                     | 400         | Request body contains an unexpected field |
| INVALID_IDENTIFIER                   | 400         | `:id` is not a 24-character hex string |
| UNAUTHENTICATED                      | 401         | No valid token supplied |
| FORBIDDEN                            | 403         | Token role is neither `Admin` nor `OperationsUser` |
| NOT_FOUND                            | 404         | No transfer matches `:id` |
| INVALID_STATUS_TRANSITION            | 409         | The transfer is not currently `Requested` |
| INSUFFICIENT_AVAILABLE_QUANTITY      | 409         | The transfer quantity exceeds the source location's available quantity |

**Example request:**

```http
POST /api/transfers/65a1f0c8e4b0a1c2d3e4f601/dispatch
Authorization: Bearer <token>
Content-Type: application/json

{}
```

**Example response:**

```json
{
  "id": "65a1f0c8e4b0a1c2d3e4f601",
  "item": {
    "id": "65a1f0c8e4b0a1c2d3e4f5a1",
    "code": "SKU-001",
    "name": "Widget",
    "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
  },
  "batch": "BATCH-A",
  "sourceLocation": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
  "destinationLocation": { "id": "65a1f0c8e4b0a1c2d3e4f5d2", "code": "WH-02", "name": "Secondary Warehouse" },
  "quantity": 20,
  "receivedQuantity": 0,
  "status": "Dispatched",
  "createdAt": "2024-05-01T14:00:00.000Z",
  "dispatchedAt": "2024-05-01T15:00:00.000Z",
  "receivedAt": null
}
```

### `POST /api/transfers/:id/receive`

**Permitted roles:** `Admin`, `OperationsUser`.

**Request schema — path params:**

| Field | Type   | Constraints |
|-------|--------|--------------|
| id    | string | required, 24-character hexadecimal identifier |

**Request body:** none accepted (empty object only).

**Success response:** `200 OK` — the internal transfer shape above, with
`status: "Received"`, `receivedQuantity` equal to `quantity`, and `receivedAt` set.

**Errors:**

| Code                          | HTTP Status | When |
|---------------------------------|-------------|------|
| VALIDATION_ERROR               | 400         | Request body contains an unexpected field |
| INVALID_IDENTIFIER             | 400         | `:id` is not a 24-character hex string |
| UNAUTHENTICATED                | 401         | No valid token supplied |
| FORBIDDEN                      | 403         | Token role is neither `Admin` nor `OperationsUser` |
| NOT_FOUND                      | 404         | No transfer matches `:id` |
| INVALID_STATUS_TRANSITION      | 409         | The transfer is not currently `Dispatched` |
| TRANSFER_ALREADY_RECEIVED      | 409         | The transfer already holds status `Received`, or a concurrent receipt committed first |

**Example request:**

```http
POST /api/transfers/65a1f0c8e4b0a1c2d3e4f601/receive
Authorization: Bearer <token>
Content-Type: application/json

{}
```

**Example response:**

```json
{
  "id": "65a1f0c8e4b0a1c2d3e4f601",
  "item": {
    "id": "65a1f0c8e4b0a1c2d3e4f5a1",
    "code": "SKU-001",
    "name": "Widget",
    "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
  },
  "batch": "BATCH-A",
  "sourceLocation": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
  "destinationLocation": { "id": "65a1f0c8e4b0a1c2d3e4f5d2", "code": "WH-02", "name": "Secondary Warehouse" },
  "quantity": 20,
  "receivedQuantity": 20,
  "status": "Received",
  "createdAt": "2024-05-01T14:00:00.000Z",
  "dispatchedAt": "2024-05-01T15:00:00.000Z",
  "receivedAt": "2024-05-01T16:00:00.000Z"
}
```

---

## 6. Customer Orders

Every customer order response uses this shape:

```json
{
  "id": "string",
  "customerName": "string",
  "item": {
    "id": "string",
    "code": "string",
    "name": "string",
    "category": { "id": "string", "name": "string" }
  },
  "location": { "id": "string", "code": "string", "name": "string" },
  "quantity": 0,
  "status": "Reserved | Cancelled",
  "reservations": [
    { "item": "string", "location": "string", "batch": "string", "quantity": 0 }
  ],
  "createdAt": "string"
}
```

### `GET /api/orders`

**Permitted roles:** any authenticated role.

**Request schema — query params (optional):**

| Field  | Type   | Constraints |
|--------|--------|--------------|
| status | string | one of `Reserved`, `Cancelled` |

**Success response:** `200 OK` — array of the customer order shape above.

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| VALIDATION_ERROR     | 400         | `status` is not one of the two allowed values |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not one of the three declared roles |

**Example request:**

```http
GET /api/orders?status=Reserved
Authorization: Bearer <token>
```

**Example response:**

```json
[
  {
    "id": "65a1f0c8e4b0a1c2d3e4f701",
    "customerName": "Example Customer",
    "item": {
      "id": "65a1f0c8e4b0a1c2d3e4f5a1",
      "code": "SKU-001",
      "name": "Widget",
      "category": { "id": "65a1f0c8e4b0a1c2d3e4f5b1", "name": "Hardware" }
    },
    "location": { "id": "65a1f0c8e4b0a1c2d3e4f5d1", "code": "WH-01", "name": "Main Warehouse" },
    "quantity": 60,
    "status": "Reserved",
    "reservations": [
      { "item": "65a1f0c8e4b0a1c2d3e4f5a1", "location": "65a1f0c8e4b0a1c2d3e4f5d1", "batch": "BATCH-A", "quantity": 60 }
    ],
    "createdAt": "2024-05-01T17:00:00.000Z"
  }
]
```

### `GET /api/orders/:id`

**Permitted roles:** any authenticated role.

**Request schema — path params:**

| Field | Type   | Constraints |
|-------|--------|--------------|
| id    | string | required, 24-character hexadecimal identifier |

**Success response:** `200 OK` — single object of the customer order shape above.

**Errors:**

| Code                | HTTP Status | When |
|----------------------|-------------|------|
| INVALID_IDENTIFIER   | 400         | `:id` is not a 24-character hex string |
| UNAUTHENTICATED      | 401         | No valid token supplied |
| FORBIDDEN            | 403         | Token role is not one of the three declared roles |
| NOT_FOUND            | 404         | No customer order matches `:id` |

**Example request:**

```http
GET /api/orders/65a1f0c8e4b0a1c2d3e4f701
Authorization: Bearer <token>
```

**Example response:** same shape as the `GET /api/orders` example above, as a single object.

### `POST /api/orders`

**Permitted roles:** `Admin`, `SalesUser`.

**Request body:**

| Field         | Type   | Constraints |
|---------------|--------|--------------|
| customerName  | string | required, trimmed, 1–120 characters |
| item          | string | required, 24-character hexadecimal identifier, must reference an existing Item |
| location      | string | required, 24-character hexadecimal identifier, must reference an existing Location |
| quantity      | number | required, integer, 1–1,000,000 |

No other field is accepted.

**Success response:** `201 Created` — the customer order shape above, with
`status: "Reserved"` and a `reservations` array whose quantities sum to `quantity`.

**Errors:**

| Code                                 | HTTP Status | When |
|---------------------------------------|-------------|------|
| VALIDATION_ERROR                     | 400         | `customerName` is missing, blank, or over-length |
| INVALID_QUANTITY                     | 400         | `quantity` is not an integer from 1 to 1,000,000 |
| INVALID_REFERENCE                    | 400         | `item` or `location` does not match an existing document |
| UNAUTHENTICATED                      | 401         | No valid token supplied |
| FORBIDDEN                            | 403         | Token role is neither `Admin` nor `SalesUser` |
| INSUFFICIENT_AVAILABLE_QUANTITY      | 409         | The requested quantity cannot be fully reserved from available inventory at that item/location |
| CONCURRENT_MODIFICATION              | 409         | A transient transaction conflict persisted after 3 retries |

**Example request:**

```http
POST /api/orders
Authorization: Bearer <token>
Content-Type: application/json

{
  "customerName": "Example Customer",
  "item": "65a1f0c8e4b0a1c2d3e4f5a1",
  "location": "65a1f0c8e4b0a1c2d3e4f5d1",
  "quantity": 60
}
```

**Example response:** same shape as the `GET /api/orders/:id` example above.

---

## 7. Error Code Reference

This table lists every error code declared in `backend/src/errors/errorCodes.js`, exactly as
the Error_Handler returns it, together with its HTTP status.

| Code                             | HTTP Status | Description |
|-----------------------------------|--------------|--------------|
| VALIDATION_ERROR                 | 400          | Schema violation, unknown body field, blank or over-length string |
| INVALID_QUANTITY                 | 400          | Quantity not an integer in 1..1,000,000 |
| INVALID_REFERENCE                | 400          | Referenced item, location, user, or source record does not exist |
| INVALID_IDENTIFIER                | 400          | Path or query id is not a 24-character hex string |
| MALFORMED_JSON                    | 400          | JSON content type with an unparseable body |
| SAME_LOCATION_TRANSFER             | 400          | Transfer source equals destination |
| INVALID_CREDENTIALS                | 401          | Login email unmatched or password comparison failed |
| UNAUTHENTICATED                    | 401          | Token absent, undecodable, badly signed, or expired |
| FORBIDDEN                          | 403          | Role not permitted, unmapped write route, or unknown role |
| NOT_FOUND                          | 404          | Well-formed id matching no document |
| ROUTE_NOT_FOUND                    | 404          | No declared route matches method and path |
| DUPLICATE_INVENTORY_RECORD         | 409          | Item + location + batch already exists |
| DUPLICATE_INVENTORY_TRANSACTION    | 409          | Movement reference already used |
| INSUFFICIENT_PHYSICAL_QUANTITY     | 409          | Movement would drive physical below 0 |
| INSUFFICIENT_AVAILABLE_QUANTITY    | 409          | Movement would drive reserved above physical, or dispatch/reservation exceeds availability |
| INVALID_STATUS_TRANSITION          | 409          | Target status is not the successor of the current status |
| TRANSFER_ALREADY_RECEIVED          | 409          | Receipt against an already received transfer |
| CONCURRENT_MODIFICATION            | 409          | Transient transaction error persisted after 3 retries |
| INTERNAL_ERROR                     | 500          | Any error carrying no explicit status |

Every error response body carries the shape `{ code, message }`, plus an optional `details`
array of `{ field, reason }` entries for validation failures.

---

## 8. Required Environment Variables

The Config_Loader (`backend/src/config/index.js`) reads exactly these four variables at
startup. Full setup detail, including example values, lives in the README.

| Variable      | Purpose |
|----------------|----------|
| MONGODB_URI    | Connection string for the MongoDB replica-set deployment |
| JWT_SECRET     | Secret used to sign and verify access tokens (at least 32 characters) |
| PORT           | TCP port the API_Server listens on (1–65535) |
| CORS_ORIGIN    | The single origin the API_Server's CORS policy allows |

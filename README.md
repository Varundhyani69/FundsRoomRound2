# Mini Operations ERP

A small operations ERP covering the flow Inventory → Work Order → Stock Check → Internal Transfer / Shortage → Customer Reservation.

## Stack

- **Backend:** Node.js, Express, Mongoose, MongoDB (replica set, for multi-document transactions), bcrypt, jsonwebtoken, zod
- **Frontend:** Vite + React
- **Tests:** Jest, Supertest, `mongodb-memory-server` (single-node replica set), fast-check on the backend; Vitest + React Testing Library on the frontend
- **Language:** plain JavaScript (no TypeScript)

Layout: `backend/` and `frontend/`, both at the repository root.

Full setup instructions, environment variable table, run commands, seed users, and API/schema documentation are added in the documentation increment.

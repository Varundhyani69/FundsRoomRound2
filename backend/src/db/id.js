// backend/src/db/id.js -- generates the CHAR(24) primary keys every table uses.
//
// 24 lowercase hex characters, matching the shape the API's validation layer
// already enforces (`identifier` in src/validation/common.js, /^[a-f0-9]{24}$/).
// Keeping that shape means the HTTP contract, the OpenAPI spec, and the web client
// are all driven by one id format.
//
// 12 random bytes = 96 bits of entropy per id, drawn from crypto.randomBytes
// (a CSPRNG), so ids are unguessable and collisions are not a practical concern:
// the tables here hold thousands of rows, against a 2^96 space.
//
// Deliberately NOT AUTO_INCREMENT -- see the header comment in schema.sql for why.

const crypto = require('crypto');

const ID_BYTES = 12; // 12 bytes -> 24 hex characters

/** @returns {string} a fresh 24-character lowercase hex identifier */
function newId() {
    return crypto.randomBytes(ID_BYTES).toString('hex');
}

module.exports = { newId, ID_BYTES };

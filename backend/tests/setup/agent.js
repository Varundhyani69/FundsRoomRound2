// backend/tests/setup/agent.js -- the single place tests obtain an HTTP client from.
// Every mandatory test issues real HTTP requests against the exported Express app, so
// CORS, requestLog, validation, authorization and the error handler are all inside each
// assertion (Req 12.13). The app never listens; supertest binds an ephemeral port.

const request = require('supertest');
const app = require('../../src/app');

/**
 * A supertest agent over the exported app.
 * @returns {import('supertest').SuperTest<import('supertest').Test>}
 */
function agent() {
    return request(app);
}

module.exports = { agent, app };

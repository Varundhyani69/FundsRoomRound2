// backend/src/app.js -- the Express app and the fixed middleware order.
// It never calls listen() and never opens a Database connection, so Supertest can
// drive it in-process (Req 12.13). server.js owns the process concerns.

const express = require('express');
const cors = require('cors');

const config = require('./config');
const requestLog = require('./middleware/requestLog');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const apiRouter = require('./routes');
const openapiSpec = require('./openapi');
const health = require('./health');

const app = express();

// 1. CORS, with the single permitted Web_Client origin taken from config.
app.use(cors({ origin: config.corsOrigin }));

// 2. requestLog, deliberately ahead of the body parser.
//    The design diagram lists it after express.json(), but express.json() calls
//    next(err) for an unparseable body, which skips every remaining non-error
//    middleware. Mounted after the parser it would never register its 'finish'
//    listener for a malformed-JSON request, so that response would go unlogged.
//    Req 9.8 wants one line for EVERY finished response, so it runs first. It
//    only attaches a listener and calls next(), so nothing else is affected.
app.use(requestLog);

// 3. JSON body parsing. An unparseable body raises a SyntaxError that
//    errorHandler turns into MALFORMED_JSON (Req 9.11).
app.use(express.json());

// 4. Health probes, mounted OUTSIDE `/api` and ahead of everything expensive.
//    A load balancer polls these every few seconds and holds no token, so they
//    are unauthenticated and return nothing about the data -- see src/health.js
//    for why liveness and readiness are two separate endpoints.
app.get('/health', health.liveness);
app.get('/health/ready', health.readiness);

// 5. API documentation: the OpenAPI document as raw JSON, and nothing else.
//    No HTML UI is mounted any more. The spec is the machine-readable artifact --
//    a reviewer imports this URL straight into Postman or Insomnia, and
//    scripts/postman.js derives the tracked Postman collection from the same
//    module -- so shipping a browser UI (and the dependency behind it) bought
//    nothing the JSON does not already give.
//    Still mounted OUTSIDE `/api` on purpose: under `/api` it would become an
//    undocumented entry in the API's own route table (the one tests/docs.test.js
//    asserts against the spec), and it is not part of the API surface -- it
//    describes it. Unauthenticated by design: the spec contains no data, only the
//    shape of the API, and a reviewer needs to read it before they have a token.
app.get('/docs.json', (req, res) => res.status(200).json(openapiSpec));

// 6. Routes. Routers are mounted inside routes/index.js.
app.use('/api', apiRouter);

// 7. No declared route matched the method and path (Req 9.12).
app.use(notFound);

// 8. LAST middleware: the one place an error becomes an HTTP response (Req 9.5).
app.use(errorHandler);

module.exports = app;

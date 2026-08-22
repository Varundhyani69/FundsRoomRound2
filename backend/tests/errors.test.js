// backend/tests/errors.test.js -- the error surface of the API server.
// Covers the single permitted response envelope (Req 9.5), INTERNAL_ERROR message
// hygiene (Req 9.6, 9.7), the one-line-per-finished-response request log
// (Req 9.8), MALFORMED_JSON (Req 9.11) and ROUTE_NOT_FOUND (Req 9.12).

const express = require('express');
const request = require('supertest');

const { agent } = require('./setup/agent');
const requestLog = require('../src/middleware/requestLog');
const notFound = require('../src/middleware/notFound');
const errorHandler = require('../src/middleware/errorHandler');
const AppError = require('../src/errors/AppError');
const ERROR_CODES = require('../src/errors/errorCodes');

// Strings a leaking error handler would echo back to a client. None of them names
// anything real; they only have to be recognisable in a response body.
const LEAKED_FILE_PATH = 'E:\\fake\\project\\src\\services\\inventory.service.js';
const LEAKED_MODULE = 'fakeInventoryServiceModule';
const LEAKED_DB_TEXT =
    'MongoServerError: E11000 duplicate key error collection: fakedb.faketransactions index: fake_reference_1';
const LEAKED_STRINGS = [LEAKED_FILE_PATH, LEAKED_MODULE, LEAKED_DB_TEXT];

/**
 * A throwaway app carrying the same middleware order as src/app.js around one
 * route that raises whatever the test needs. The real app declares no routes yet,
 * so this is the only way to drive the non-404 branches of the error handler.
 */
function appThatThrows(raise) {
    const app = express();
    app.use(requestLog);
    app.use(express.json());
    app.get('/boom', (req, res, next) => {
        try {
            raise();
            next(new Error('raise() did not throw'));
        } catch (error) {
            next(error);
        }
    });
    app.use(notFound);
    app.use(errorHandler);
    return app;
}

// The request log writes on the response's 'finish' event, which can land a tick
// after supertest resolves. Yielding the event loop makes the assertion stable.
const settle = () =>
    new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

describe('error response envelope', () => {
    test('an unmatched path returns exactly { code, message } with ROUTE_NOT_FOUND', async () => {
        const response = await agent().get('/api/does-not-exist');

        expect(response.status).toBe(404);
        expect(Object.keys(response.body).sort()).toEqual(['code', 'message']);
        expect(response.body.code).toBe('ROUTE_NOT_FOUND');
        expect(typeof response.body.message).toBe('string');
        expect(response.body.message.length).toBeGreaterThan(0);
        // An AppError raised without details must not grow a details key.
        expect(response.body).not.toHaveProperty('details');
    });

    test('an unmatched method on a path also returns ROUTE_NOT_FOUND', async () => {
        const response = await agent().post('/api');

        expect(response.status).toBe(404);
        expect(response.body.code).toBe('ROUTE_NOT_FOUND');
    });

    test('an AppError carrying details returns them in the body', async () => {
        const details = [{ field: 'quantity', reason: 'must be an integer' }];
        const app = appThatThrows(() => {
            throw new AppError(400, 'VALIDATION_ERROR', 'Request is invalid.', {
                details,
            });
        });

        const response = await request(app).get('/boom');

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            code: 'VALIDATION_ERROR',
            message: 'Request is invalid.',
            details,
        });
    });

    test('an AppError carrying a cause does not leak it into the body', async () => {
        const app = appThatThrows(() => {
            throw new AppError(404, 'NOT_FOUND', 'No matching record exists.', {
                cause: new Error(LEAKED_DB_TEXT),
            });
        });

        const response = await request(app).get('/boom');

        expect(response.status).toBe(404);
        expect(Object.keys(response.body).sort()).toEqual(['code', 'message']);
        expect(response.text).not.toContain(LEAKED_DB_TEXT);
    });

    test('every declared error code maps to an HTTP status between 400 and 599', () => {
        const codes = Object.keys(ERROR_CODES);
        expect(codes.length).toBeGreaterThan(0);

        for (const code of codes) {
            const status = ERROR_CODES[code];
            expect(Number.isInteger(status)).toBe(true);
            expect(status).toBeGreaterThanOrEqual(400);
            expect(status).toBeLessThanOrEqual(599);
        }
    });
});

describe('malformed JSON', () => {
    test('a JSON content type with an unparseable body returns 400 MALFORMED_JSON', async () => {
        const response = await agent()
            .post('/api/anything')
            .set('Content-Type', 'application/json')
            .send('{not json');

        expect(response.status).toBe(400);
        expect(Object.keys(response.body).sort()).toEqual(['code', 'message']);
        expect(response.body.code).toBe('MALFORMED_JSON');
        expect(response.body.message.length).toBeGreaterThan(0);
    });

    test('the malformed body itself is not echoed back', async () => {
        const response = await agent()
            .post('/api/anything')
            .set('Content-Type', 'application/json')
            .send('{"secret": "hunter2"');

        expect(response.status).toBe(400);
        expect(response.text).not.toContain('hunter2');
    });
});

describe('INTERNAL_ERROR hygiene', () => {
    let errorSpy;
    let logSpy;

    beforeEach(() => {
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('an error with no explicit status returns a generic 500 that leaks nothing', async () => {
        const leaky = new Error(
            `${LEAKED_DB_TEXT} raised in ${LEAKED_MODULE} at ${LEAKED_FILE_PATH}`
        );
        leaky.stack = `${leaky.message}\n    at handler (${LEAKED_FILE_PATH}:42:11)`;
        const app = appThatThrows(() => {
            throw leaky;
        });

        const response = await request(app).get('/boom');

        expect(response.status).toBe(500);
        expect(Object.keys(response.body).sort()).toEqual(['code', 'message']);
        expect(response.body.code).toBe('INTERNAL_ERROR');
        expect(response.body.message).toBe('Something went wrong.');
        expect(response.body).not.toHaveProperty('stack');
        expect(response.body).not.toHaveProperty('details');

        // Nothing from the thrown error reaches the client, in the body or elsewhere.
        for (const leaked of LEAKED_STRINGS) {
            expect(response.text).not.toContain(leaked);
        }
        expect(response.text).not.toContain(' at handler ');

        // The full detail did reach the server log.
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toBe('[unhandled]');
        expect(errorSpy.mock.calls[0][1]).toBe(leaky);
        expect(errorSpy.mock.calls[0][1].message).toContain(LEAKED_DB_TEXT);
        expect(errorSpy.mock.calls[0][1].stack).toContain(LEAKED_FILE_PATH);

        await settle();
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toBe('GET /boom 500 INTERNAL_ERROR');
    });

    test('a thrown non-Error value still returns the generic 500 envelope', async () => {
        const app = appThatThrows(() => {
            // eslint-disable-next-line no-throw-literal
            throw LEAKED_DB_TEXT;
        });

        const response = await request(app).get('/boom');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            code: 'INTERNAL_ERROR',
            message: 'Something went wrong.',
        });
        expect(response.text).not.toContain(LEAKED_DB_TEXT);
    });

    test('an untranslated duplicate-key error returns 409 DUPLICATE_INVENTORY_TRANSACTION', async () => {
        const app = appThatThrows(() => {
            throw Object.assign(new Error(LEAKED_DB_TEXT), { code: 11000 });
        });

        const response = await request(app).get('/boom');

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            code: 'DUPLICATE_INVENTORY_TRANSACTION',
            message: expect.any(String),
        });
        expect(response.text).not.toContain(LEAKED_DB_TEXT);
        // The safety net is an expected outcome, not an unhandled failure.
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

describe('request log line', () => {
    let logSpy;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('a 2xx response logs one line of method, path and status with no code', async () => {
        const app = express();
        app.use(requestLog);
        app.get('/ok', (req, res) => res.status(200).json({ ok: true }));
        app.use(notFound);
        app.use(errorHandler);

        const response = await request(app).get('/ok?verbose=1&page=2');
        await settle();

        expect(response.status).toBe(200);
        expect(logSpy).toHaveBeenCalledTimes(1);
        // Query string stripped, no trailing error code on a success.
        expect(logSpy.mock.calls[0][0]).toBe('GET /ok 200');
    });

    test('a 404 response logs one line ending with the error code', async () => {
        const response = await agent().get('/api/missing-thing');
        await settle();

        expect(response.status).toBe(404);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toBe(
            'GET /api/missing-thing 404 ROUTE_NOT_FOUND'
        );
    });

    test('a malformed-JSON response is logged too', async () => {
        // requestLog runs before express.json() precisely so this line exists: the
        // parser's next(err) skips every remaining non-error middleware.
        const response = await agent()
            .put('/api/anything')
            .set('Content-Type', 'application/json')
            .send('{not json');
        await settle();

        expect(response.status).toBe(400);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toBe(
            'PUT /api/anything 400 MALFORMED_JSON'
        );
    });

    test('each finished response contributes exactly one line', async () => {
        await agent().get('/api/one');
        await agent().get('/api/two');
        await agent().delete('/api/three');
        await settle();

        expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
            'GET /api/one 404 ROUTE_NOT_FOUND',
            'GET /api/two 404 ROUTE_NOT_FOUND',
            'DELETE /api/three 404 ROUTE_NOT_FOUND',
        ]);
    });
});

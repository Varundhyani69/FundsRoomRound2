// frontend/src/api/client.test.js -- property-based test for the API client
// module (task 10.12).
//
// global.fetch is mocked per test so no real network call is ever made, and
// the token is read/written through the module's own getToken/setToken/
// clearToken exports rather than touching localStorage directly, so this
// file never needs to know the storage key name (client.js is the only
// module that knows it).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';

import { get, post, patch, getToken, setToken, clearToken, onSessionEnded, ApiError } from './client.js';

// Every run here mocks fetch and localStorage only -- no real network call
// and no database -- so the count is set comfortably above the Req 12.7
// floor of 25 without slowing the suite down.
const RUNS = { numRuns: 30 };

// One path segment shape, reused by every case below. Query strings and
// path params are irrelevant to this property: the client attaches the
// same header regardless of what the path looks like.
const genPath = fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
        minLength: 1,
        maxLength: 20,
    })
    .map((segment) => `/api/${segment}`);

const genToken = fc.string({ minLength: 1, maxLength: 40 });

const genBody = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 10 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { maxKeys: 5 }
);

// Every non-login call the client exposes: GET takes no body, POST/PATCH
// carry an arbitrary body. There is no dedicated login function in
// client.js (login is just a post() call issued before any token exists),
// so exercising get/post/patch generically covers "any call other than
// login" for the client's own contract.
const genCall = fc.record({
    verb: fc.constantFrom('get', 'post', 'patch'),
    path: genPath,
    body: genBody,
});

function invoke(call) {
    if (call.verb === 'get') return get(call.path);
    if (call.verb === 'post') return post(call.path, call.body);
    return patch(call.path, call.body);
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

let fetchMock;
let sessionEndedCount;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    sessionEndedCount = 0;
    // client.js keeps a single listener slot, so registering here once per
    // test is enough; each property iteration below resets the counter it
    // increments rather than re-registering.
    onSessionEnded(() => {
        sessionEndedCount += 1;
    });
    clearToken();
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
});

// Feature: mini-operations-erp, Property 19: The client attaches the token and reacts to every 401
// Validates: Requirements 11.3, 11.4, 11.12, 11.14
describe('Property 19: The client attaches the token and reacts to every 401', () => {
    test('a stored token is attached as a Bearer Authorization header on every non-login call', async () => {
        await fc.assert(
            fc.asyncProperty(genCall, genToken, async (call, token) => {
                fetchMock.mockClear();
                clearToken();
                setToken(token);
                fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

                await invoke(call);

                expect(fetchMock).toHaveBeenCalledTimes(1);
                const [, options] = fetchMock.mock.calls[0];
                expect(options.headers.Authorization).toBe(`Bearer ${token}`);
            }),
            RUNS
        );
    });

    test('an HTTP 401 response discards the token, notifies the session-ended listener, and throws ApiError UNAUTHENTICATED', async () => {
        await fc.assert(
            fc.asyncProperty(genCall, genToken, async (call, token) => {
                fetchMock.mockClear();
                clearToken();
                setToken(token);
                sessionEndedCount = 0;
                fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));

                let thrown;
                try {
                    await invoke(call);
                } catch (error) {
                    thrown = error;
                }

                expect(thrown).toBeInstanceOf(ApiError);
                expect(thrown.code).toBe('UNAUTHENTICATED');
                expect(getToken()).toBeNull();
                expect(sessionEndedCount).toBe(1);
            }),
            RUNS
        );
    });

    const genNonAuthErrorStatus = fc.constantFrom(400, 403, 404, 409, 500);
    const genErrorCode = fc.string({ minLength: 1, maxLength: 20 });
    const genErrorMessage = fc.string({ minLength: 1, maxLength: 60 });

    test('a non-401 error response throws an ApiError carrying the response body code and message, and leaves the token and session untouched', async () => {
        await fc.assert(
            fc.asyncProperty(
                genCall,
                genToken,
                genNonAuthErrorStatus,
                genErrorCode,
                genErrorMessage,
                async (call, token, status, code, message) => {
                    fetchMock.mockClear();
                    clearToken();
                    setToken(token);
                    sessionEndedCount = 0;
                    fetchMock.mockResolvedValueOnce(jsonResponse(status, { code, message }));

                    let thrown;
                    try {
                        await invoke(call);
                    } catch (error) {
                        thrown = error;
                    }

                    expect(thrown).toBeInstanceOf(ApiError);
                    expect(thrown.code).toBe(code);
                    expect(thrown.message).toBe(message);
                    expect(getToken()).toBe(token);
                    expect(sessionEndedCount).toBe(0);
                }
            ),
            RUNS
        );
    });

    const genPayload = fc.dictionary(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        { maxKeys: 5 }
    );

    test('a successful response returns the parsed JSON payload as-is', async () => {
        await fc.assert(
            fc.asyncProperty(genCall, genToken, genPayload, async (call, token, payload) => {
                fetchMock.mockClear();
                clearToken();
                setToken(token);
                fetchMock.mockResolvedValueOnce(jsonResponse(200, payload));

                const result = await invoke(call);

                expect(result).toEqual(payload);
            }),
            RUNS
        );
    });
});

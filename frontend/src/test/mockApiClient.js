// frontend/src/test/mockApiClient.js -- shared vi.mock() replacement for
// '../api/client.js'.
//
// All five screens (task 10.11) import get/post/patch from the same
// api/client.js module, so every screen test needs to mock the same
// exports. Centralising the mock here means each screen test file writes
// one line instead of repeating the same vi.fn() boilerplate five times:
//
//   vi.mock('../api/client.js', () => import('../test/mockApiClient.js'));
//
// Vitest allows a vi.mock() factory to return a Promise, so returning the
// dynamic import directly works: the resolved module namespace object
// becomes the mocked module. Only the exports the screens actually use are
// provided.
//
// Each mock function is a plain vi.fn() with no default behaviour --
// individual tests configure return values/rejections with
// mockResolvedValueOnce/mockRejectedValueOnce, and should call
// vi.clearAllMocks() in beforeEach so state does not leak between tests in
// the same file.
import { vi } from 'vitest';

export const get = vi.fn();
export const post = vi.fn();
export const patch = vi.fn();

export const getToken = vi.fn();
export const setToken = vi.fn();
export const clearToken = vi.fn();

export const getUser = vi.fn();
export const setUser = vi.fn();
export const clearUser = vi.fn();

export const onSessionEnded = vi.fn();

// Mirrors the real ApiError shape (code, message) so tests can throw it
// from a mocked rejection and screens can read err.message/err.code the
// same way they do against the real client.
export class ApiError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
    }
}

// frontend/src/api/client.js -- fetch wrapper: base URL, JWT header, global
// 401 handling. One module, so the token, the Authorization header, and the
// session-ended rule all live in one place (design.md "API client").
//
// This module has no React dependency and does not import AuthContext.
// AuthContext (task 10.3) calls setToken/clearToken on login/logout, and
// registers a listener with onSessionEnded so it can react when this module
// detects a 401 from the API.

const BASE = import.meta.env.VITE_API_BASE_URL; // no hard-coded fallback. Req 10.8

const TOKEN_KEY = 'mini-erp-token';
const USER_KEY = 'mini-erp-user';

// One stable error shape for every non-2xx response so callers can branch on
// `error.code` instead of parsing messages (Req 11.12).
export class ApiError extends Error {
    constructor(code, message) {
        super(message || 'Something went wrong. Please try again.');
        this.name = 'ApiError';
        this.code = code;
    }
}

// --- Token storage -----------------------------------------------------
// Read/write directly under one localStorage key. AuthContext calls these
// instead of touching localStorage itself, so this module is the only place
// that knows the storage key.

export function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
}

// The user object (id, email, role, assignedLocation) is stored under its
// own key next to the token, so AuthContext never touches localStorage
// directly and this file stays the single place that knows the storage
// keys (design.md "state ... persisted in localStorage under one key" --
// interpreted here as one key per stored value, both owned by this module).

export function getUser() {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function setUser(user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser() {
    localStorage.removeItem(USER_KEY);
}

// --- Session-ended notification ----------------------------------------
// A tiny subscribable callback so this module can announce a 401 without
// importing React or AuthContext. AuthContext registers its own logout
// handler here during setup.

let sessionEndedListener = null;

export function onSessionEnded(callback) {
    sessionEndedListener = callback;
}

function notifySessionEnded() {
    clearToken();
    if (sessionEndedListener) sessionEndedListener();
}

// --- Request ------------------------------------------------------------

export async function request(path, { method = 'GET', body } = {}) {
    const token = getToken();
    const response = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}), // Req 11.3
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
        notifySessionEnded(); // clears the token and signals AuthContext (Req 11.4)
        throw new ApiError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.');
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload.code, payload.message); // Req 11.12
    return payload;
}

// Convenience wrappers for the three verbs the backend actually uses
// (GET, POST, PATCH -- see backend/src/routes). Callers that need something
// else can still call `request` directly.

export function get(path) {
    return request(path);
}

export function post(path, body) {
    return request(path, { method: 'POST', body });
}

export function patch(path, body) {
    return request(path, { method: 'PATCH', body });
}

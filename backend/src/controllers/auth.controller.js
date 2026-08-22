// backend/src/controllers/auth.controller.js
// The login handler. Like every controller it reads only `req.validated` (never raw
// `req.body`), calls one service function, and shapes the response. No business rule
// lives here: the identical-rejection decision and the token contents belong to
// src/services/auth.service.js.

const authService = require('../services/auth.service');

/**
 * POST /api/auth/login
 * 200 { token, user: { id, email, role, assignedLocation } }
 * 400 VALIDATION_ERROR (raised by validate() before this runs, Req 1.11)
 * 401 INVALID_CREDENTIALS (raised by the service, Req 1.2, 1.3, 1.4)
 */
async function login(req, res, next) {
    // The schema already trimmed and lowercased the email, so the service receives
    // exactly the stored form.
    const { email, password } = req.validated.body;

    try {
        const result = await authService.login(email, password);
        return res.status(200).json(result);
    } catch (error) {
        // Express 4 does not observe a rejected promise, so the error is handed to
        // next() explicitly: errorHandler stays the only place that writes an error
        // response (Req 9.5).
        return next(error);
    }
}

module.exports = { login };

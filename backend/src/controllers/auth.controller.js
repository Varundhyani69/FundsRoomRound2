// Auth controller: login handler.

const authService = require('../services/auth.service');

/** POST /api/auth/login */
async function login(req, res, next) {
    const { email, password } = req.validated.body;

    try {
        const result = await authService.login(email, password);
        return res.status(200).json(result);
    } catch (error) {
        // Express 4 does not observe a rejected promise
        return next(error);
    }
}

module.exports = { login };

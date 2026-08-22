// backend/src/routes/auth.routes.js -- the only public router.
// It is mounted in routes/index.js ahead of `authenticate`, because a caller cannot
// present a token before it has one (Req 1.8). `authorize` is not attached either:
// there is no Role to evaluate yet.

const express = require('express');

const validate = require('../middleware/validate');
const { loginBody } = require('../validation/auth.schemas');
const authController = require('../controllers/auth.controller');

const router = express.Router();

// validate() runs first, so a malformed request is rejected with 400 before the
// handler and therefore before any password comparison (Req 1.11, 9.1).
router.post('/login', validate({ body: loginBody }), authController.login);

module.exports = router;

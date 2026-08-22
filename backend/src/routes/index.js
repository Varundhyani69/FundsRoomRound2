// backend/src/routes/index.js -- the /api router, mounted by app.js.
// Empty for now: auth mounts here in increment 2, then authenticate is applied to
// every later router so no unauthenticated request reaches role evaluation
// (Req 1.8, 2.1). No route is declared before its increment, so an undeclared
// path keeps falling through to notFound and the documented route list stays
// exactly the implemented one (Req 13.9).

const express = require('express');

const router = express.Router();

module.exports = router;

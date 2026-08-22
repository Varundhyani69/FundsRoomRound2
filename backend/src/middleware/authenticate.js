// backend/src/middleware/authenticate.js -- mounted on the API router for every
// route except POST /api/auth/login, so an unidentified request is rejected
// before any role evaluation happens (Req 1.8, 2.1).
//
// Every failure mode -- header absent, header not shaped as `Bearer <token>`,
// token undecodable, signature mismatch, expiry passed -- produces the SAME
// 401 UNAUTHENTICATED response with the same message. The client is told only
// that it is not identified, never which of those conditions applied
// (Req 1.8, 1.9).

const jwt = require('jsonwebtoken');
const config = require('../config');
const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

// `Bearer` is matched case-insensitively and extra internal whitespace between
// the scheme and the token is tolerated; anything else (another scheme, a bare
// token, a scheme with no token) does not match and is rejected.
const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

// One message for every rejection, built fresh per call because AppError is
// mutable and carries a per-request stack.
const unauthenticated = () =>
    new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'UNAUTHENTICATED',
        'Authentication is required for this request.'
    );

function authenticate(req, res, next) {
    const header = req.get('authorization');
    const match = typeof header === 'string' ? header.match(BEARER) : null;
    if (!match) {
        return next(unauthenticated());
    }

    let payload;
    try {
        // Verified directly here against the secret from the Config_Loader, so
        // this middleware depends on no service module (Req 1.7). Signature
        // failure and expiry both throw, and both land in the same catch.
        payload = jwt.verify(match[1], config.jwtSecret);
    } catch (error) {
        // The underlying reason stays on the server: it is kept as `cause`,
        // which AppError declares non-enumerable so it cannot reach a response
        // body (Req 9.7).
        return next(
            new AppError(
                ERROR_CODES.UNAUTHENTICATED,
                'UNAUTHENTICATED',
                'Authentication is required for this request.',
                { cause: error }
            )
        );
    }

    // A token this server signed always carries both claims. A payload missing
    // either one is therefore not a token this server would issue, and passing a
    // half-formed user through would leave authorize() evaluating an undefined
    // role -- a 403 for what is really an unidentified caller. Treat it as
    // UNAUTHENTICATED instead (Req 1.7, 1.9).
    if (!payload || typeof payload !== 'object' || !payload.sub || !payload.role) {
        return next(unauthenticated());
    }

    // Exactly these two fields, never the raw payload, so nothing downstream can
    // read a claim that is not part of the declared request context (Req 1.7).
    req.user = { id: payload.sub, role: payload.role };
    return next();
}

module.exports = authenticate;

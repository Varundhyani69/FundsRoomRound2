// backend/src/health.js -- liveness and readiness probes for a container
// orchestrator (ECS, Kubernetes) or a load balancer target group.
//
// Mounted OUTSIDE `/api`, for the same reason `/docs` is: these endpoints are
// operational infrastructure, not part of the API surface the documentation and
// tests/docs.test.js describe. They are also unauthenticated by necessity -- a
// load balancer has no token -- which is why neither of them returns anything
// about the data. Only whether this process can serve traffic.
//
// TWO probes, not one, because they answer different questions and a single
// endpoint conflates them:
//
//   GET /health        liveness.  "Is this process alive?" No database call.
//   GET /health/ready  readiness. "Can this process serve a request?" Pings the
//                                 database.
//
// Point a RESTART policy at liveness and a LOAD BALANCER at readiness. Getting
// that the wrong way round is a real outage mode: if a restart policy checked
// readiness, a brief database blip would kill every healthy container at once and
// the pool would be cold when the database came back. Liveness stays deliberately
// trivial so it can only fail when the event loop is genuinely wedged.

const { query } = require('./db/pool');

/**
 * Liveness: the process is up and the event loop is turning. Deliberately does no
 * I/O, so it cannot fail for a reason outside this process.
 */
function liveness(req, res) {
    res.status(200).json({ status: 'ok' });
}

/**
 * Readiness: this process holds a working database connection, so a request routed
 * here can actually be served.
 *
 * `SELECT 1` on a pooled connection is the cheapest statement that proves the whole
 * path works -- the pool has a connection, the credentials are accepted, and the
 * server answers. It touches no application table, so it stays correct if the
 * schema changes.
 *
 * On failure the reason is logged and the response says only that the dependency is
 * unreachable: this endpoint is public, and a connection error carries the host,
 * port, and user it failed with (the same discipline as Req 9.6, 9.7).
 */
async function readiness(req, res) {
    try {
        await query('SELECT 1');
        res.status(200).json({ status: 'ok', database: 'reachable' });
    } catch (error) {
        console.error('[health] readiness probe failed', error);
        res.status(503).json({ status: 'unavailable', database: 'unreachable' });
    }
}

module.exports = { liveness, readiness };

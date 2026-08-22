// backend/src/server.js -- the process: config -> connect -> listen, plus graceful
// shutdown. app.js holds no process concern so Supertest can drive it in-process.

// Requiring config resolves and validates the environment first; a missing or
// invalid variable exits non-zero here, before the Database connection is opened
// and before the port is bound (Req 10.1, 10.2).
const config = require('./config');
const { connect, disconnect } = require('./db/connect');
const app = require('./app');

const SHUTDOWN_DEADLINE_MS = 10_000;

let server;
let shuttingDown = false;

async function start() {
    await connect();

    server = app.listen(config.port, () => {
        console.log(`[api] listening on port ${config.port}`);
    });
}

/**
 * Stops accepting connections, then closes the Mongoose connection, which ends
 * every open session and aborts its in-progress transaction, and exits 0. A
 * 10-second timer forces a non-zero exit if that has not completed (Req 8.4).
 */
async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down`);

    // unref() so the timer never keeps the process alive on its own; it only
    // fires if the process is still running because shutdown has stalled.
    const deadline = setTimeout(() => {
        console.error(
            `[api] shutdown did not complete within ${SHUTDOWN_DEADLINE_MS} ms, forcing exit`
        );
        process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();

    try {
        if (server) {
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
        await disconnect();
        clearTimeout(deadline);
        process.exit(0);
    } catch (error) {
        console.error('[api] shutdown failed', error);
        clearTimeout(deadline);
        process.exit(1);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
    console.error('[api] startup failed', error);
    process.exit(1);
});

// backend/tests/setup/poolCount.js -- lets a test compare the number of connections the pool
// has checked out before and after a request, to confirm withTransaction.js releases every
// connection it acquires and none leak (Req 8.3).
//
// This replaced `sessionCount.js`, which read MongoDB's `serverStatus().transactions.
// currentOpen`. The MySQL equivalent of a leaked session is a leaked POOL CONNECTION: a
// transaction that never calls `connection.release()` keeps that connection checked out
// forever, and after `connectionLimit` such requests the pool blocks and the server stops
// answering. That failure mode is exactly what these counts detect.
//
// The numbers come from the mysql2 pool's own internal lists rather than from a server-side
// query, because "checked out by this process" is a client-side fact -- MySQL's own
// `SHOW STATUS LIKE 'Threads_connected'` counts every client on the server, including the
// developer's own session, so it cannot isolate this process's behaviour.

const { getPool } = require('../../src/db/pool');

/**
 * Reads how many pooled connections are currently checked out (acquired and not yet
 * released).
 *
 * mysql2 keeps three internal lists: every connection it has opened, the ones sitting free,
 * and the ones mid-acquisition. In use = all - free. The leading underscores mark these as
 * mysql2 internals rather than public API, so they are read in this one helper only; if a
 * future mysql2 changes them, this file is the single place to fix.
 *
 * @returns {number}
 */
function getInUseConnectionCount() {
    const pool = getPool();
    const all = pool.pool._allConnections.toArray().length;
    const free = pool.pool._freeConnections.toArray().length;
    return all - free;
}

/**
 * Reads how many connections the pool has opened in total, free or not. Useful for asserting
 * that a burst of requests did not grow the pool past its configured limit.
 *
 * @returns {number}
 */
function getOpenConnectionCount() {
    return getPool().pool._allConnections.toArray().length;
}

module.exports = { getInUseConnectionCount, getOpenConnectionCount };

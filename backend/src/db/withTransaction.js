// backend/src/db/withTransaction.js -- the one wrapper that owns connection
// lifecycle and transient-error retry for multi-statement writes
// (Req 8.1, 8.2, 8.3, 8.5).
//
// Services pass a callback that receives a dedicated connection and performs EVERY
// read and write on it:
//     await withTransaction(async (tx) => { ... tx.query(...) ... })
// A query issued against the pool instead of `tx` runs OUTSIDE the transaction and
// is neither rolled back on failure nor re-read on a retry.
//
// Why a connection per transaction: in MySQL, BEGIN/COMMIT/ROLLBACK are connection
// state, not call parameters. Two concurrent requests sharing one connection would
// interleave statements inside each other's transaction. Taking a connection out of
// the pool for the transaction's duration is what keeps them isolated.

const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');
const { getPool } = require('./pool');

// 3 retries means at most 4 executions of the callback in total (Req 8.5).
const MAX_RETRIES = 3;

/**
 * MySQL error codes that are worth re-running rather than reporting.
 *
 * - ER_LOCK_DEADLOCK (1213): InnoDB detected a deadlock and chose this transaction
 *   as the victim, rolling it back. The work is simply lost, not wrong -- running
 *   it again from its first read is the documented remedy.
 * - ER_LOCK_WAIT_TIMEOUT (1205): this transaction waited too long for a row lock
 *   another transaction held. Also a timing outcome, not a logical failure.
 *
 * Everything else -- our own AppError guards, ER_DUP_ENTRY from a unique index, a
 * CHECK constraint violation, a bad column -- is deterministic and would fail again
 * identically, so retrying it would only delay the same error.
 */
const TRANSIENT_ERROR_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const TRANSIENT_ERRNOS = new Set([1213, 1205]);

function isTransient(error) {
    if (!error) return false;
    return TRANSIENT_ERROR_CODES.has(error.code) || TRANSIENT_ERRNOS.has(error.errno);
}

// Built fresh per call because AppError carries a per-request stack.
const concurrentModification = (cause) =>
    new AppError(
        ERROR_CODES.CONCURRENT_MODIFICATION,
        'CONCURRENT_MODIFICATION',
        'The data changed while this request was being processed. Please retry.',
        { cause }
    );

/**
 * Runs `work(connection)` inside one MySQL transaction: commits on success and
 * returns the callback's result, rolls back on any error, and releases the
 * connection on every exit path.
 *
 * @param {(connection: import('mysql2/promise').PoolConnection) => Promise<any>} work
 * @returns {Promise<any>} whatever `work` resolved to on the committing attempt
 * @throws the callback's own error when it is not transient, or a 409
 *   `CONCURRENT_MODIFICATION` AppError once the retries are exhausted.
 */
async function withTransaction(work) {
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        // A fresh connection per attempt, so a retry genuinely re-executes the
        // callback from its first read and carries no transaction state over from
        // the failed attempt (Req 8.1, 8.5).
        const connection = await getPool().getConnection();

        try {
            await connection.beginTransaction();
            const result = await work(connection);
            await connection.commit();
            return result;
        } catch (error) {
            // Rollback leaves every row the transaction touched at its exact
            // pre-transaction value (Req 8.2). A rollback failure is swallowed
            // because the transaction is already doomed -- and after a deadlock
            // InnoDB has already rolled it back, so the ROLLBACK is a no-op that
            // can itself complain. The original error is what the caller needs.
            await connection.rollback().catch(() => { });

            lastError = error;

            // Non-transient errors propagate immediately -- no pointless retries.
            if (!isTransient(error)) {
                throw error;
            }
        } finally {
            // Runs after commit, after rollback, and after an unhandled error,
            // which is what returns the connection to the pool and keeps the
            // in-use count at its baseline (Req 8.3). Without this the pool would
            // be exhausted after `connectionLimit` failed requests.
            connection.release();
        }
    }

    // The fourth execution also failed transiently (Req 8.5).
    throw concurrentModification(lastError);
}

module.exports = { withTransaction, MAX_RETRIES, isTransient };

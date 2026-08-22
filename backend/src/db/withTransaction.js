// backend/src/db/withTransaction.js -- the one wrapper that owns session lifecycle
// and transient-error retry for multi-document writes (Req 8.1, 8.2, 8.3, 8.5).
//
// Services pass a callback that receives the session and performs EVERY read and
// write with it:
//     await withTransaction(async (session) => { ... })
// A read or write that forgets `.session(session)` runs outside the transaction and
// is neither rolled back on abort nor re-read on a retry.

const mongoose = require('mongoose');
const AppError = require('../errors/AppError');
const ERROR_CODES = require('../errors/errorCodes');

// 3 retries means at most 4 executions of the callback in total (Req 8.5).
const MAX_RETRIES = 3;

/**
 * True only for the two labels the MongoDB driver attaches to errors that are
 * worth re-running: the transaction was interrupted by a conflict, or the commit
 * outcome is unknown. Every other error -- our own AppError guards, duplicate-key
 * errors, validation errors -- is deterministic and would fail again identically.
 */
function isTransient(error) {
    return Boolean(
        error &&
        typeof error.hasErrorLabel === 'function' &&
        (error.hasErrorLabel('TransientTransactionError') ||
            error.hasErrorLabel('UnknownTransactionCommitResult'))
    );
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
 * Runs `work(session)` inside one MongoDB transaction: commits on success and
 * returns the callback's result, aborts on any error, and ends the session on
 * every exit path.
 *
 * @param {(session: import('mongoose').ClientSession) => Promise<any>} work
 * @returns {Promise<any>} whatever `work` resolved to on the committing attempt
 * @throws the callback's own error when it is not transient, or a 409
 *   `CONCURRENT_MODIFICATION` AppError once the retries are exhausted.
 */
async function withTransaction(work) {
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        // A fresh session per attempt, so a retry genuinely re-executes the
        // callback from its first read and carries nothing over from the failed
        // attempt (Req 8.1, 8.5).
        const session = await mongoose.startSession();

        try {
            session.startTransaction();
            const result = await work(session);
            await session.commitTransaction();
            return result;
        } catch (error) {
            // Abort leaves every document the transaction touched at its exact
            // pre-transaction value (Req 8.2). An abort failure is swallowed
            // because the transaction is already doomed and the original error is
            // what the caller needs.
            await session.abortTransaction().catch(() => { });

            lastError = error;

            // Non-transient errors propagate immediately -- no pointless retries.
            if (!isTransient(error)) {
                throw error;
            }
        } finally {
            // Runs after commit, after abort, and after an unhandled error, which
            // is what returns the open-session count to its baseline (Req 8.3).
            await session.endSession();
        }
    }

    // The fourth execution also failed transiently (Req 8.5).
    throw concurrentModification(lastError);
}

module.exports = { withTransaction, MAX_RETRIES };

// backend/tests/setup/sessionCount.js -- lets a test compare the number of open
// MongoDB sessions before and after a request, to confirm withTransaction.js is
// ending every session it opens and none are leaking (Req 8.3).
//
// `serverStatus().transactions.currentOpen` is used rather than
// `logicalSessionRecordCache.activeSessionsCount`: the latter is a TTL-based cache
// that does not shrink immediately when a session ends, so it cannot detect a leak
// within a single test. `transactions.currentOpen` reflects live open transactions
// and returns to 0 as soon as `endSession()` runs, which is exactly what
// `withTransaction.js` calls on every exit path.

const mongoose = require('mongoose');

/**
 * Reads the number of MongoDB transactions the server currently reports as open.
 * Every transaction `withTransaction.js` starts corresponds to one open session, so
 * this returns to its pre-request value once every session from that request has
 * been ended.
 *
 * @returns {Promise<number>}
 */
async function getOpenSessionCount() {
    const status = await mongoose.connection.db.admin().command({ serverStatus: 1 });
    return status.transactions.currentOpen;
}

module.exports = { getOpenSessionCount };

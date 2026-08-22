// backend/tests/harness.test.js -- proves the test harness itself: the in-memory
// deployment is a replica set (Req 12.8, 12.9), a Transaction can be started and
// committed on it, and the supertest agent reaches the exported app (Req 12.13).

const mongoose = require('mongoose');

const { getReplicaSetName } = require('../src/db/connect');
const { agent } = require('./setup/agent');

describe('test harness', () => {
    test('the in-memory deployment reports a replica-set name', async () => {
        const setName = await getReplicaSetName();

        expect(typeof setName).toBe('string');
        expect(setName.length).toBeGreaterThan(0);
    });

    test('a transaction can be started and committed', async () => {
        // Unique per invocation, and dropped in a `finally`, so this test never
        // observes state left by an earlier run or an earlier failure: it passes in
        // any execution order (Req 12.11). The raw driver collection is not tracked by
        // mongoose.connection.collections, so the per-test reset in dbSetup.js does not
        // clear it for us.
        const collectionName = `harness_smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        // Created outside the transaction so the commit only carries the write.
        await mongoose.connection.db
            .createCollection(collectionName)
            .catch(() => undefined);
        const collection = mongoose.connection.db.collection(collectionName);

        try {
            const session = await mongoose.connection.startSession();
            try {
                session.startTransaction();
                await collection.insertOne({ marker: 'committed' }, { session });
                // Not yet visible outside the session.
                expect(await collection.countDocuments({ marker: 'committed' })).toBe(0);
                await session.commitTransaction();
            } finally {
                await session.endSession();
            }

            expect(await collection.countDocuments({ marker: 'committed' })).toBe(1);
        } finally {
            await collection.drop().catch(() => undefined);
        }
    });

    test('an unmatched path returns 404 ROUTE_NOT_FOUND through the agent', async () => {
        const response = await agent().get('/no-such-path');

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
            code: 'ROUTE_NOT_FOUND',
            message: expect.any(String),
        });
    });
});

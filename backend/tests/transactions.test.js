// backend/tests/transactions.test.js -- unit tests for src/db/withTransaction.js: rollback
// totality on an injected mid-transaction failure, in-use pool connection count
// returning to its pre-request baseline, the retry count and CONCURRENT_MODIFICATION at
// exhaustion, and a graceful shutdown smoke test (Req 8.2, 8.3, 8.4, 8.5, 8.8).
//
// The concurrency-under-real-load scenarios (two unawaited requests racing each other) live
// in tests/concurrency.test.js; this file drives withTransaction.js and the server process
// directly, one failure mode at a time.

const path = require('path');
const { InventoryRecord, InventoryTransaction } = require('./setup/tables');
const { spawn } = require('child_process');

const { withTransaction, MAX_RETRIES } = require('../src/db/withTransaction');
const { applyMovement } = require('../src/services/inventory.service');
const AppError = require('../src/errors/AppError');
const { agent } = require('./setup/agent');
const { getInUseConnectionCount } = require('./setup/poolCount');
const { FIXTURE_INVENTORY_RECORDS, FIXTURE_ITEMS, FIXTURE_LOCATIONS, tokenFor } = require('./setup/seedFixture');

const post = async (route, body, role = 'Admin') =>
    agent()
        .post(route)
        .set('Authorization', `Bearer ${await tokenFor(role)}`)
        .send(body);

describe('rollback totality on an injected mid-transaction failure (Req 8.2, 8.8)', () => {
    test('a transaction whose second write fails leaves every row it touched at its exact pre-transaction value', async () => {
        const recordId = FIXTURE_INVENTORY_RECORDS.widgetMainBatchA.id;

        const before = await InventoryRecord.findById(recordId).lean();
        const ledgerBefore = await InventoryTransaction.find({ inventoryRecord: recordId }).lean();

        // Two applyMovement calls in one withTransaction: the first commits nothing by
        // itself (nothing it wrote is visible outside this connection yet), and the second
        // reuses the same movementReference the first just wrote, so the UNIQUE index on
        // inventory_transactions.movement_reference rejects it with ER_DUP_ENTRY before this
        // transaction can commit (Req 4.5). The whole transaction -- including the first,
        // otherwise-legal write -- must therefore leave no trace.
        const duplicateRef = 'transactions-test-rollback-duplicate-ref';
        await expect(
            withTransaction(async (tx) => {
                await applyMovement(
                    recordId,
                    { physicalDelta: 5, reservedDelta: 0, movementReference: duplicateRef },
                    tx
                );
                await applyMovement(
                    recordId,
                    { physicalDelta: 5, reservedDelta: 0, movementReference: duplicateRef },
                    tx
                );
            })
        ).rejects.toMatchObject({ code: 'DUPLICATE_INVENTORY_TRANSACTION' });

        const after = await InventoryRecord.findById(recordId).lean();
        expect(after).toEqual(before);

        const ledgerAfter = await InventoryTransaction.find({ inventoryRecord: recordId }).lean();
        expect(ledgerAfter).toEqual(ledgerBefore);
        // Neither the first write's ledger row nor a second one persisted.
        expect(await InventoryTransaction.findOne({ movementReference: duplicateRef })).toBeNull();
    });
});

describe('in-use pool connection count returns to baseline (Req 8.3)', () => {
    test('a successful transactional HTTP request leaves the in-use pool connection count unchanged', async () => {
        const before = await getInUseConnectionCount();

        const response = await post('/api/inventory', {
            item: FIXTURE_ITEMS.gadget.id,
            location: FIXTURE_LOCATIONS.secondary.id,
            batch: 'SESSION-COUNT-OK',
            physicalQuantity: 10,
            movementReference: 'transactions-test-session-count-success',
        });
        expect(response.status).toBe(201);

        const after = await getInUseConnectionCount();
        expect(after).toBe(before);
    });

    test('an HTTP request that fails inside the transaction also leaves the in-use pool connection count unchanged', async () => {
        const recordId = FIXTURE_INVENTORY_RECORDS.widgetMainBatchB.id; // physical 50, reserved 0

        const before = await getInUseConnectionCount();

        // OUT 1,000 against a physical quantity of 50 drives assertSufficientPhysical to
        // throw INSUFFICIENT_PHYSICAL_QUANTITY, a non-transient error that aborts the
        // transaction on its first attempt (Req 4.2).
        const response = await post(`/api/inventory/${recordId}/adjust`, {
            direction: 'OUT',
            quantity: 1000,
            movementReference: 'transactions-test-session-count-failure',
        });
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('INSUFFICIENT_PHYSICAL_QUANTITY');

        const after = await getInUseConnectionCount();
        expect(after).toBe(before);
    });
});

describe('retry count and CONCURRENT_MODIFICATION at exhaustion (Req 8.5)', () => {
    test('a callback that always throws a transient error runs exactly 4 times then rejects with 409 CONCURRENT_MODIFICATION', async () => {
        // A plain Error carrying the two fields mysql2 sets on a real deadlock -- `code`
        // 'ER_LOCK_DEADLOCK' and `errno` 1213 -- so withTransaction's isTransient() check
        // sees exactly what InnoDB choosing this transaction as its deadlock victim would
        // present, without having to provoke a genuine deadlock on demand.
        //
        // Provoking one for real is what tests/concurrency.test.js does; this test is about
        // the retry BUDGET, which needs an error that is transient every single time. A real
        // deadlock resolves on the retry, so it can never exhaust the budget.
        const makeTransientError = () => {
            const error = new Error('simulated transient transaction error');
            error.code = 'ER_LOCK_DEADLOCK';
            error.errno = 1213;
            error.sqlState = '40001';
            return error;
        };

        let callCount = 0;
        let thrown;
        try {
            await withTransaction(async () => {
                callCount += 1;
                throw makeTransientError();
            });
        } catch (error) {
            thrown = error;
        }

        // 3 retries means 4 executions of the callback in total (Req 8.5).
        expect(MAX_RETRIES).toBe(3);
        expect(callCount).toBe(4);

        expect(thrown).toBeInstanceOf(AppError);
        expect(thrown.code).toBe('CONCURRENT_MODIFICATION');
        expect(thrown.status).toBe(409);
    });
});

describe('graceful shutdown smoke test (Req 8.4)', () => {
    // Documenting the choice, as instructed:
    //
    // The obvious test -- spawn `src/server.js` as a child process and call
    // `child.kill('SIGTERM')` from this file -- was tried first and does not work on
    // Windows: Node's own child_process docs state that on Windows "the signal argument
    // will be ignored except for 'SIGKILL', 'SIGTERM', ... and the process will always be
    // killed forcefully and abruptly (similar to 'SIGKILL')" when a PARENT sends a signal
    // to a CHILD process. That was confirmed empirically here too: a child with its own
    // `process.on('SIGTERM', ...)` handler that calls `process.exit(0)` after a short delay
    // still exits with `{ code: null, signal: 'SIGTERM' }` -- the handler never runs, the
    // OS just kills the process. Windows has no real SIGTERM to deliver cross-process, so
    // no amount of retrying that approach would make it exercise server.js's shutdown().
    //
    // What actually reaches the code Req 8.4 describes -- `connect()`, `listen()`,
    // `server.close()`, `disconnect()`, `process.exit(0)`, all inside the 10-second
    // deadline -- is having the SIGNAL originate INSIDE the process that owns the
    // listener, which is exactly what happens on every platform once a real signal is
    // delivered: Node's internal signal watcher calls `process.emit(signal)` on the
    // receiving process itself. So this test spawns a short wrapper script (not server.js
    // modified, not this test file's own process) that requires the real, unmodified
    // `src/server.js`, watches its own stdout for the "listening on port" log line
    // server.js already prints, and then calls `process.emit('SIGTERM')` on itself --
    // triggering the very same `process.on('SIGTERM', ...)` listener a real signal would,
    // without depending on Windows' broken cross-process signal delivery. The parent (this
    // test) only observes the child's reported exit code and elapsed time, which is
    // exactly what Req 8.4 asks for.
    test('the server process exits with status 0 within the 10-second deadline after SIGTERM', async () => {
        const serverPath = path.join(__dirname, '..', 'src', 'server.js');

        // Emits its own SIGTERM once server.js's own startup log confirms it is listening,
        // then lets the real, unmodified shutdown() run to completion.
        const wrapperScript = [
            'const originalLog = console.log;',
            'console.log = (...args) => {',
            '  originalLog(...args);',
            "  if (typeof args[0] === 'string' && args[0].includes('listening on port')) {",
            "    process.emit('SIGTERM');",
            '  }',
            '};',
            `require(${JSON.stringify(serverPath)});`,
        ].join('\n');

        const child = spawn(process.execPath, ['-e', wrapperScript], {
            cwd: path.join(__dirname, '..'),
            // Inherits the MYSQL_* / JWT_SECRET / CORS_ORIGIN variables from this worker's
            // process.env (set by tests/setup/dbSetup.js, pointing at the same throwaway test
            // database every other test in this file uses); only PORT is overridden so this
            // spawned server never contends with a port another test process might hold.
            env: { ...process.env, PORT: '4319' },
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        const startedAt = Date.now();
        const exited = new Promise((resolve, reject) => {
            const failSafe = setTimeout(
                () => reject(new Error(`server did not exit within 12s. stderr: ${stderr}`)),
                12000
            );
            child.on('exit', (code) => {
                clearTimeout(failSafe);
                resolve(code);
            });
            child.on('error', (error) => {
                clearTimeout(failSafe);
                reject(error);
            });
        });

        const code = await exited;
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(10_000);
        expect(code).toBe(0);
    }, 15000);
});

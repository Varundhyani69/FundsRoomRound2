// backend/scripts/docker-start.js -- the container entrypoint: wait for MySQL,
// apply the schema, then hand over to the real server.
//
// Written in Node rather than as a shell script on purpose. A `.sh` entrypoint
// authored on Windows carries CRLF line endings, and Linux then fails to execute
// it with the famously unhelpful "no such file or directory" (it is looking for an
// interpreter called `/bin/sh\r`). A `.js` file has no such failure mode, and it
// can reuse `migrate()` directly instead of shelling out to npm.
//
// WHY MIGRATE HERE. `schema.sql` is entirely `CREATE TABLE IF NOT EXISTS`, so
// applying it on every boot is a no-op against an already-migrated database. That
// makes "migrate then start" safe to run on every deploy and removes a manual step
// a reviewer would otherwise have to know about.
//
// The honest limit of that: if several tasks start at once they all attempt the
// same DDL, and concurrent `CREATE TABLE` on the same name can block or deadlock.
// It is fine at one or two tasks, which is this project's shape. Past that, run the
// migration as a one-off task before the rolling deploy and set
// `RUN_MIGRATIONS=false` on the service -- which is why that switch exists rather
// than the behaviour being hard-coded.
//
// WHY WAIT. `depends_on: condition: service_healthy` in Compose and a container
// dependency in ECS both reduce the race but neither eliminates it: MySQL accepting
// TCP is not the same as MySQL being ready to authenticate. RDS in particular can
// refuse connections for a while after the endpoint resolves. So the wait is here,
// in the process that actually needs the database, rather than being assumed.

const config = require('../src/config');
const { migrate } = require('./migrate');

// `false` disables migration; anything else (including unset) leaves it on, so the
// safe default needs no configuration.
const RUN_MIGRATIONS = process.env.RUN_MIGRATIONS !== 'false';

// Seeding is OPT-IN, the opposite default to migration, because the two carry very
// different risk. Migrating is a no-op against an already-migrated database, while
// seeding writes rows and resets each seeded user's password to whatever
// SEED_*_PASSWORD currently holds. Running that unasked on every boot of a
// long-lived deployment would be surprising.
//
// It exists because some hosts give no shell on their free tier, so
// `npm run seed` cannot be run by hand after the first deploy -- and without it
// there are no users and nobody can log in. Set RUN_SEED=true for the first deploy,
// then remove it.
//
// Safe to leave on if you prefer: seed.js upserts on each business key, so
// repeated runs converge on the same rows rather than duplicating them.
const RUN_SEED = process.env.RUN_SEED === 'true';

// 30 attempts at 2s is a 60-second budget, comfortably longer than a cold MySQL
// container takes to accept authentication and shorter than a deployment timeout.
const MAX_ATTEMPTS = Number(process.env.DB_WAIT_ATTEMPTS) || 30;
const RETRY_DELAY_MS = Number(process.env.DB_WAIT_DELAY_MS) || 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `migrate()` against `config.mysql`, retrying while the database refuses the
 * connection.
 *
 * Only CONNECTION-shaped failures are retried. A rejected password, a missing
 * privilege, or a broken statement in `schema.sql` would fail identically on every
 * attempt, so retrying them would just delay the error by a minute and bury the
 * real cause under twenty-nine repeats.
 */
async function migrateWhenReachable() {
    const retryable = new Set([
        'ECONNREFUSED',      // nothing listening yet
        'ENOTFOUND',         // DNS not resolving yet (an RDS endpoint mid-creation)
        'EAI_AGAIN',         // transient DNS failure
        'ETIMEDOUT',         // reachable but not answering
        'PROTOCOL_CONNECTION_LOST',
        'ER_CON_COUNT_ERROR', // server up but out of connection slots
    ]);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const { database, statements } = await migrate(config.mysql);
            console.log(
                `[start] schema applied to "${database}": ${statements} statement(s). ` +
                'Re-running is safe.'
            );
            return;
        } catch (error) {
            const isRetryable = retryable.has(error.code);
            if (!isRetryable) {
                // Deterministic: report it as-is rather than hiding it behind retries.
                throw error;
            }
            if (attempt === MAX_ATTEMPTS) {
                throw new Error(
                    `Database not reachable after ${MAX_ATTEMPTS} attempts ` +
                    `(${(MAX_ATTEMPTS * RETRY_DELAY_MS) / 1000}s): ${error.code}. ` +
                    'Check MYSQL_HOST/MYSQL_PORT and the security group or network rules.'
                );
            }
            console.log(
                `[start] database not ready (${error.code}), ` +
                `attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${RETRY_DELAY_MS}ms`
            );
            await sleep(RETRY_DELAY_MS);
        }
    }
}

/**
 * Runs the seed script as a child process.
 *
 * A child process rather than `require('./seed.js')` because seed.js is written as a
 * command: it sets `process.exitCode` and opens and closes its own pool. Requiring it
 * here would leave this process's exit code set by the seed and race its
 * `disconnect()` against the pool server.js is about to open. A child gets its own
 * lifecycle, and we read only its exit status.
 */
async function seed() {
    const { spawn } = require('child_process');
    const path = require('path');

    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'seed.js')], {
            stdio: 'inherit', // seed.js reports the users it created; let that reach the logs
            env: process.env,
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                // Non-fatal on purpose. A failed seed means missing SEED_* passwords or
                // rows that already exist -- neither is a reason to refuse to serve
                // traffic, and crash-looping the container would hide the log line that
                // says what was actually wrong.
                console.error(
                    `[start] seed exited with code ${code}; continuing to start the server. ` +
                    'Check the seed output above.'
                );
                resolve();
            }
        });
    });
}

async function main() {
    if (RUN_MIGRATIONS) {
        await migrateWhenReachable();
    } else {
        console.log('[start] RUN_MIGRATIONS=false, skipping schema migration');
    }

    if (RUN_SEED) {
        console.log('[start] RUN_SEED=true, loading the seed dataset');
        await seed();
    }

    // Requiring server.js starts it: it opens the pool, binds the port, and installs
    // its own SIGINT/SIGTERM graceful-shutdown handlers (Req 8.4). Nothing is wrapped
    // around it, so the shutdown path a container's SIGTERM hits is the same one
    // tests/transactions.test.js exercises.
    require('../src/server.js');
}

main().catch((error) => {
    console.error(`[start] startup failed: ${error.message}`);
    process.exit(1);
});

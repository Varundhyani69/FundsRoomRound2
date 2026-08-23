// backend/tests/modelRegistration.test.js -- regression test for a real bug found while
// running the server outside the test harness: GET /api/inventory (and every other route
// that populates an Item's Category) threw a 500 INTERNAL_ERROR because Mongoose's
// `MissingSchemaError` fired for 'Category'.
//
// The cause: nothing in the server's own request path ever required
// `src/models/Category.js`, so its schema was never registered with Mongoose. It only
// worked under `npm test` because `tests/setup/seedFixture.js` happens to require
// `../../src/models/Category` directly, which registered the schema as an unrelated side
// effect before any test ran -- masking the bug in every other test file in this suite.
//
// This test proves the fix (`src/models/Item.js` now requires `./Category` itself) by
// spawning a fresh Node process that requires ONLY `src/models/Item.js`, with no fixture
// file anywhere on its module graph, and then asks Mongoose to resolve the 'Category'
// model by name -- exactly what `.populate('category')` does internally. A fresh process
// is necessary because every other test file in this suite shares one Node process, and by
// the time this file's tests run, some earlier file has almost certainly already required
// Category.js some other way; a fresh process is the only way to observe the server's real,
// unassisted module graph.

const path = require('path');
const { spawnSync } = require('child_process');

test('requiring src/models/Item.js alone registers the Category model Mongoose needs to populate it', () => {
    const itemModelPath = path.join(__dirname, '..', 'src', 'models', 'Item');

    const script = [
        "const mongoose = require('mongoose');",
        `require(${JSON.stringify(itemModelPath)});`,
        // Throws MissingSchemaError itself if 'Category' was never registered -- the same
        // failure `.populate('category')` hit in production.
        "mongoose.model('Category');",
        "console.log('CATEGORY_MODEL_REGISTERED');",
    ].join('\n');

    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
    });

    expect(result.stderr).not.toMatch(/MissingSchemaError/);
    expect(result.stdout).toContain('CATEGORY_MODEL_REGISTERED');
    expect(result.status).toBe(0);
});

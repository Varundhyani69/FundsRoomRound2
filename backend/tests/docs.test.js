// backend/tests/docs.test.js -- documentation matches the code it describes (Req 13.9).
//
// `docs/api.md` claims to be generated from the source, not from the design plan, so this
// test proves that claim rather than trusting it: it parses the markdown as plain text and
// compares three lists against the three modules that actually declare them --
// `backend/src/routes/` (via the real app, walked the same way tests/authorization.test.js
// walks it), `backend/src/errors/errorCodes.js`, and `backend/src/config/index.js`. No HTTP
// request is made and no database is touched -- every comparison is between static text and
// static code structure, so this file needs neither `tests/setup/agent.js` nor a live
// connection.

const fs = require('fs');
const path = require('path');

const { app } = require('./setup/agent');
const ERROR_CODES = require('../src/errors/errorCodes');
const config = require('../src/config');

const API_DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'api.md');
const apiDoc = fs.readFileSync(API_DOC_PATH, 'utf8');

// ---------------------------------------------------------------------------------------
// Part 1: the route table (Req 13.9)
// ---------------------------------------------------------------------------------------

/** The literal mount path of a router layer, e.g. `/api` for `app.use('/api', router)`. */
function mountPath(layer) {
    if (layer.regexp.fast_slash) {
        return '';
    }

    const mounted = layer.regexp.source
        .replace(/^\^/, '')
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/');

    // A mount path carrying a parameter or any other pattern would leave regular
    // expression syntax behind and produce a wrong key. Fail loudly rather than report an
    // incomplete route list.
    if (/[$^?*+()[\]\\]/.test(mounted)) {
        throw new Error(
            `Cannot read the mount path of a router layer from ${layer.regexp}. ` +
            'tests/docs.test.js expects every router to be mounted on a literal path.'
        );
    }
    return mounted;
}

/**
 * Walk the whole mounted router stack and return every declared route as a
 * `"<METHOD> <mounted path>"` string, e.g. `"POST /api/inventory/:id/adjust"`. Unlike
 * tests/authorization.test.js's `declaredWriteRoutes`, this keeps GET routes too, so it
 * covers the entire route table, not just the write routes.
 */
function declaredRoutes(expressApp, stack = expressApp._router.stack, prefix = '') {
    return stack.flatMap((layer) => {
        if (layer.route) {
            return Object.keys(layer.route.methods).map((method) => {
                const fullPath = `${prefix}${layer.route.path}`;
                // A router index route is declared as `'/'`, e.g. `items.get('/', ...)`.
                // Mounted, that yields a trailing slash (`/api/items/`) that the docs never
                // write; every write route in the app instead uses `''` for the same spot
                // (see the routers' own comments) and needs no such trim. Stripping a
                // trailing slash here, and only here, makes both spellings compare equal.
                const normalized =
                    fullPath.length > 1 && fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath;
                return `${method.toUpperCase()} ${normalized}`;
            });
        }
        if (layer.handle && layer.handle.stack) {
            return declaredRoutes(expressApp, layer.handle.stack, prefix + mountPath(layer));
        }
        return [];
    });
}

/** Every `### `METHOD /path`` heading in the doc, in the order they appear. */
function documentedRoutes(doc) {
    const matches = [...doc.matchAll(/^### `(GET|POST|PATCH|PUT|DELETE) (\/api\/[^`]+)`$/gm)];
    return matches.map(([, method, routePath]) => `${method} ${routePath}`);
}

// ---------------------------------------------------------------------------------------
// Part 2: the error code list (Req 13.9)
// ---------------------------------------------------------------------------------------

/**
 * The first column of every data row in the "## 7. Error Code Reference" table. The
 * section is sliced out by its heading and the next heading, so a code mentioned in prose
 * elsewhere in the document (an example error response, say) is never picked up by mistake.
 */
function documentedErrorCodes(doc) {
    const start = doc.indexOf('## 7. Error Code Reference');
    const end = doc.indexOf('## 8. Required Environment Variables');
    if (start === -1 || end === -1) {
        throw new Error('tests/docs.test.js expects sections 7 and 8 to exist in docs/api.md.');
    }
    const section = doc.slice(start, end);

    // Every code is a bare, all-caps, underscore-separated identifier -- the same shape
    // ERROR_CODES uses as a key -- so this excludes both the header row ("Code") and the
    // `|---|---|` separator row without needing to special-case them.
    const matches = [...section.matchAll(/^\|\s*([A-Z][A-Z_]*)\s*\|\s*\d{3}\s*\|/gm)];
    return matches.map(([, code]) => code);
}

// ---------------------------------------------------------------------------------------
// Part 3: the environment variable list (Req 13.9)
// ---------------------------------------------------------------------------------------

/** The first column of every data row in the "## 8. Required Environment Variables" table. */
function documentedEnvVars(doc) {
    const start = doc.indexOf('## 8. Required Environment Variables');
    if (start === -1) {
        throw new Error('tests/docs.test.js expects section 8 to exist in docs/api.md.');
    }
    const section = doc.slice(start);

    // Same reasoning as the error code table: a bare upper-snake-case identifier excludes
    // the "Variable" header row and the separator row on its own.
    const matches = [...section.matchAll(/^\|\s*([A-Z][A-Z_]*)\s*\|/gm)];
    return matches.map(([, name]) => name);
}

// ---------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------

describe('docs/api.md route table matches the declared routes (Req 13.9)', () => {
    test('every route the app declares is documented, and vice versa', () => {
        const declared = [...new Set(declaredRoutes(app))].sort();
        const documented = [...new Set(documentedRoutes(apiDoc))].sort();

        expect(documented).toEqual(declared);
    });

    // Without this, both lists being empty would also pass the assertion above.
    test('the parser and the walk each really find routes', () => {
        expect(documentedRoutes(apiDoc).length).toBeGreaterThan(0);
        expect(declaredRoutes(app).length).toBeGreaterThan(0);
    });
});

describe('docs/api.md error code table matches errorCodes.js (Req 13.9)', () => {
    test('the documented codes are exactly the keys of ERROR_CODES', () => {
        const documented = [...new Set(documentedErrorCodes(apiDoc))].sort();
        const declared = Object.keys(ERROR_CODES).sort();

        expect(documented).toEqual(declared);
    });

    test('the parser really finds error codes', () => {
        expect(documentedErrorCodes(apiDoc).length).toBeGreaterThan(0);
    });
});

describe('docs/api.md environment variable list matches config/index.js (Req 13.9)', () => {
    test('the documented variables are exactly config.REQUIRED', () => {
        const documented = [...new Set(documentedEnvVars(apiDoc))].sort();
        const declared = [...config.REQUIRED].sort();

        expect(documented).toEqual(declared);
    });

    test('the parser really finds environment variables', () => {
        expect(documentedEnvVars(apiDoc).length).toBeGreaterThan(0);
    });
});

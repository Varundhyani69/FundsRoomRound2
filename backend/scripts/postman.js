// backend/scripts/postman.js -- generates the tracked Postman collection (and a
// matching environment) from src/openapi.js. Run with `npm run postman`.
//
// Generated rather than hand-written on purpose. The OpenAPI document is already
// asserted against the real Express router by tests/docs.test.js -- a route added
// without a spec entry, or a spec entry without a route, fails the suite -- so a
// collection derived from that document cannot drift from the API either. A
// hand-maintained collection has no such anchor: it would rot silently the first
// time a path changed, and a reviewer would blame the API for a stale request.
//
// No new dependency: the spec is a plain JavaScript object and a Postman
// collection is plain JSON, so `require` plus `JSON.stringify` is the whole tool.
//
// The output is deterministic -- no timestamp, no generated id, no iteration over
// anything unordered -- so re-running this script on an unchanged spec produces a
// byte-identical file and therefore no diff to review.

const fs = require('fs');
const path = require('path');

const spec = require('../src/openapi');

// Written to the repository root, not under backend/, because the collection is a
// deliverable for a human reviewer rather than part of the server's source tree.
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'postman');
const COLLECTION_PATH = path.join(OUTPUT_DIR, 'mini-operations-erp.postman_collection.json');
const ENVIRONMENT_PATH = path.join(OUTPUT_DIR, 'mini-operations-erp.postman_environment.json');

const COLLECTION_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

// Postman writes an `id` into an exported environment. A fixed literal is used
// instead of a fresh uuid so re-running this script does not rewrite the file with
// a new id; the value only has to be unique within a Postman workspace, never
// globally random.
const ENVIRONMENT_ID = '6a8a5bff-3cc5-768d-ea07-24a400000001';

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete', 'head', 'options'];

// --- spec reading ---------------------------------------------------------------

/**
 * Resolves a local `$ref` (`#/components/schemas/Foo`) against the spec.
 *
 * Only local refs are handled because the spec is a single in-process object with
 * no external documents; an unresolvable ref throws rather than silently emitting
 * an empty body, which would look like a spec that simply had no example.
 *
 * @param {object} node any schema node, possibly a `$ref`
 * @returns {object} the node with one level of `$ref` followed
 */
function deref(node) {
    if (!node || typeof node.$ref !== 'string') {
        return node;
    }

    const segments = node.$ref.replace(/^#\//, '').split('/');
    const target = segments.reduce((current, segment) => (current ? current[segment] : undefined), spec);
    if (!target) {
        throw new Error(`Cannot resolve "${node.$ref}" -- scripts/postman.js only follows local refs.`);
    }
    return deref(target);
}

/** The `application/json` media type object of a request body, or undefined. */
function jsonRequestBody(operation) {
    const content = operation.requestBody && operation.requestBody.content;
    return content ? content['application/json'] : undefined;
}

/**
 * A placeholder value for one schema property.
 *
 * The spec's own `example` is preferred wherever it exists, so the emitted body is
 * the one the API author already vouched for. Only when it is absent is a value
 * invented from the type, and then the most restrictive hint available is used
 * (first enum member, `minimum`) so the skeleton has a fighting chance of passing
 * validation instead of failing on a value this script made up.
 *
 * @param {object} schema
 * @param {number} depth guards a schema that references itself
 */
function exampleFor(schema, depth = 0) {
    const resolved = deref(schema) || {};

    if (resolved.example !== undefined) {
        return resolved.example;
    }
    if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
        return resolved.enum[0];
    }
    if (depth > 4) {
        // Deep enough that a reviewer would edit the value by hand anyway, and the
        // only way a self-referencing schema could recurse forever.
        return null;
    }

    switch (resolved.type) {
        case 'integer':
        case 'number':
            return typeof resolved.minimum === 'number' ? resolved.minimum : 0;
        case 'boolean':
            return false;
        case 'array':
            return resolved.items ? [exampleFor(resolved.items, depth + 1)] : [];
        case 'object':
            return skeletonFrom(resolved, depth + 1);
        default:
            return '';
    }
}

/**
 * A request-body skeleton built from a schema's `properties`.
 *
 * Every declared property is emitted, not just the required ones: an optional
 * field left out of the body is invisible to a reviewer, whereas one present with
 * an empty value is an obvious edit point.
 *
 * @param {object} schema an object schema
 * @param {number} depth
 */
function skeletonFrom(schema, depth = 0) {
    const resolved = deref(schema) || {};
    const properties = resolved.properties || {};

    // Key order follows the schema's own declaration order, which is what makes the
    // emitted JSON stable across runs.
    const body = {};
    for (const [name, property] of Object.entries(properties)) {
        body[name] = exampleFor(property, depth);
    }
    return body;
}

/**
 * Whether an operation needs a token, read from the spec rather than guessed.
 *
 * OpenAPI's rule is that a per-operation `security` overrides the document-level
 * one, and that an empty array means "no security" -- which is exactly how
 * src/openapi.js marks the login route as the single public entry point. Encoding
 * the rule instead of a route list means a second public route needs no change here.
 */
function requiresAuth(operation) {
    const security = operation.security !== undefined ? operation.security : spec.security;
    return Array.isArray(security) && security.length > 0;
}

/**
 * Whether this operation is the one that hands out the token.
 *
 * Derived, not hard-coded: it is a public operation whose success response carries
 * a `token` property. That is the operation whose response is worth capturing into
 * a collection variable, whatever it happens to be called or mounted on.
 */
function issuesToken(operation) {
    if (requiresAuth(operation)) {
        return false;
    }

    const successResponses = Object.entries(operation.responses || {})
        .filter(([status]) => /^2\d\d$/.test(status))
        .map(([, response]) => response);

    return successResponses.some((response) => {
        const media = response.content && response.content['application/json'];
        const schema = media ? deref(media.schema) : undefined;
        return Boolean(schema && schema.properties && schema.properties.token);
    });
}

// --- collection assembly --------------------------------------------------------

/** The folder a path belongs to: its first segment after `/api/`. */
function folderNameFor(specPath) {
    const segments = specPath.split('/').filter((segment) => segment.length > 0);
    const apiIndex = segments.indexOf('api');
    // A path outside `/api` (there is none today, but health probes live there)
    // still gets a home rather than being dropped without a trace.
    const name = apiIndex === -1 ? segments[0] : segments[apiIndex + 1];
    return name || 'root';
}

/**
 * The Postman `url` object for one operation.
 *
 * OpenAPI's `{id}` becomes Postman's `:id` so the value shows up in Postman's
 * "Path Variables" editor instead of being buried in the URL string, and the host
 * is the `{{baseUrl}}` variable so one environment switch retargets every request.
 */
function urlFor(specPath, operation) {
    const postmanPath = specPath.replace(/\{(\w+)\}/g, ':$1');
    const segments = postmanPath.split('/').filter((segment) => segment.length > 0);
    const parameters = operation.parameters || [];

    const pathVariables = parameters
        .filter((parameter) => parameter.in === 'path')
        .map((parameter) => ({
            key: parameter.name,
            value: '',
            description: parameter.description || '',
        }));

    // Optional query parameters are emitted disabled: they document the filter
    // without sending an empty value the API would then have to reject.
    const query = parameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => {
            const entry = {
                key: parameter.name,
                value: '',
                description: parameter.description || '',
            };
            if (!parameter.required) {
                entry.disabled = true;
            }
            return entry;
        });

    const enabledQuery = query.filter((entry) => !entry.disabled);
    const rawQuery = enabledQuery.length > 0
        ? `?${enabledQuery.map((entry) => `${entry.key}=`).join('&')}`
        : '';

    const url = {
        raw: `{{baseUrl}}${postmanPath}${rawQuery}`,
        host: ['{{baseUrl}}'],
        path: segments,
    };
    if (query.length > 0) {
        url.query = query;
    }
    if (pathVariables.length > 0) {
        url.variable = pathVariables;
    }
    return url;
}

/** The request description: the operation's own prose, plus its roles if separate. */
function descriptionFor(operation) {
    const parts = [];
    if (operation.description) {
        parts.push(operation.description);
    }

    // src/openapi.js already inlines the permitted-role sentence (it derives it
    // from permissions.js), so it is only appended when the spec carries roles as
    // structured data instead -- appending unconditionally would print them twice.
    const roles = operation['x-permitted-roles'];
    if (Array.isArray(roles) && roles.length > 0 && !/Permitted roles/.test(parts.join('\n'))) {
        parts.push(`**Permitted roles:** ${roles.map((role) => `\`${role}\``).join(', ')}.`);
    }

    return parts.join('\n\n');
}

/**
 * The test script attached to the token-issuing request.
 *
 * This is the single most useful thing the collection does: it lifts the JWT out
 * of the login response into a collection variable, which every other request
 * already sends as `Bearer {{token}}`. A reviewer therefore logs in once and every
 * subsequent request is authenticated with no copy-paste and no token pasted into
 * a header by hand -- the step that, done manually, is where an API demo usually
 * stalls. It is written as a collection variable rather than an environment one so
 * it works even when no environment is selected.
 */
function tokenCaptureScript() {
    return [
        '// Captures the JWT so every other request in this collection is authenticated.',
        '// Runs automatically after this request; no copy-paste needed.',
        'const body = pm.response.json();',
        '',
        'pm.test(\'login returns a token\', function () {',
        '    pm.expect(pm.response.code).to.eql(200);',
        '    pm.expect(body).to.have.property(\'token\');',
        '});',
        '',
        'if (body && body.token) {',
        '    pm.collectionVariables.set(\'token\', body.token);',
        '}',
    ];
}

/** One Postman request item for one `path` + `method` pair. */
function itemFor(specPath, method, operation) {
    const headers = [];
    const request = {
        method: method.toUpperCase(),
        header: headers,
        url: urlFor(specPath, operation),
        description: descriptionFor(operation),
    };

    if (requiresAuth(operation)) {
        headers.push({
            key: 'Authorization',
            value: 'Bearer {{token}}',
            type: 'text',
        });
    }

    const media = jsonRequestBody(operation);
    if (media) {
        headers.push({ key: 'Content-Type', value: 'application/json', type: 'text' });

        const example = media.example !== undefined ? media.example : undefined;
        const body = example !== undefined ? example : skeletonFrom(media.schema);
        request.body = {
            mode: 'raw',
            raw: `${JSON.stringify(body, null, 4)}\n`,
            options: { raw: { language: 'json' } },
        };
    }

    const item = {
        name: operation.summary,
        request,
    };

    if (issuesToken(operation)) {
        item.event = [
            {
                listen: 'test',
                script: { type: 'text/javascript', exec: tokenCaptureScript() },
            },
        ];
    }

    return item;
}

/** The default `baseUrl`, taken from the spec's own server list. */
function defaultBaseUrl() {
    const server = (spec.servers || [])[0];
    return (server && server.url) || 'http://localhost:4000';
}

function buildCollection() {
    // Folder name -> items, filled in spec order so requests inside a folder read
    // in the order the spec declares them.
    const folders = new Map();
    let loginFolder = null;

    for (const [specPath, operations] of Object.entries(spec.paths)) {
        for (const method of HTTP_METHODS) {
            const operation = operations[method];
            if (!operation) {
                continue;
            }

            const folderName = folderNameFor(specPath);
            if (!folders.has(folderName)) {
                folders.set(folderName, []);
            }
            folders.get(folderName).push(itemFor(specPath, method, operation));

            if (issuesToken(operation)) {
                loginFolder = folderName;
            }
        }
    }

    // Folders sorted by name for a stable file, except that the folder holding the
    // login request is hoisted to the top: Postman's collection runner executes in
    // order, and every other request depends on the token that one sets.
    const folderNames = [...folders.keys()].sort();
    const ordered = loginFolder
        ? [loginFolder, ...folderNames.filter((name) => name !== loginFolder)]
        : folderNames;

    return {
        info: {
            name: `${spec.info.title} v${spec.info.version}`,
            description: [
                spec.info.description,
                '',
                '---',
                '',
                'Generated by `backend/scripts/postman.js` from `backend/src/openapi.js`.',
                'Do not edit by hand -- run `npm run postman` in `backend/` instead.',
                '',
                'Send the login request first: its test script stores the JWT in the',
                '`token` collection variable, which every other request sends as',
                '`Authorization: Bearer {{token}}`. Point `baseUrl` at another instance',
                'by editing the collection variable or selecting an environment.',
            ].join('\n'),
            schema: COLLECTION_SCHEMA,
        },
        item: ordered.map((name) => ({ name, item: folders.get(name) })),
        variable: [
            {
                key: 'baseUrl',
                value: defaultBaseUrl(),
                type: 'string',
            },
            {
                // Empty on purpose: the login request's test script fills it in, and a
                // stale token committed here would fail confusingly eight hours later.
                key: 'token',
                value: '',
                type: 'string',
            },
        ],
    };
}

function buildEnvironment() {
    return {
        id: ENVIRONMENT_ID,
        name: `${spec.info.title} -- local`,
        values: [
            { key: 'baseUrl', value: defaultBaseUrl(), type: 'default', enabled: true },
            { key: 'token', value: '', type: 'secret', enabled: true },
        ],
        // Postman requires this marker to recognise the file as an environment
        // rather than a collection on import.
        _postman_variable_scope: 'environment',
    };
}

/** Pretty-printed with 4-space indent and a trailing newline, matching the repo. */
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

function main() {
    const collection = buildCollection();
    writeJson(COLLECTION_PATH, collection);
    writeJson(ENVIRONMENT_PATH, buildEnvironment());

    const requestCount = collection.item.reduce((total, folder) => total + folder.item.length, 0);
    console.log(
        `Wrote ${requestCount} request(s) in ${collection.item.length} folder(s) to ` +
        `${path.relative(path.join(__dirname, '..', '..'), COLLECTION_PATH)} ` +
        'and its environment file. Re-running this command is safe.'
    );
    return 0;
}

// Only run when invoked directly (`npm run postman`), so a test can require the
// builders without writing files.
if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(`Postman collection generation failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { buildCollection, buildEnvironment, COLLECTION_PATH, ENVIRONMENT_PATH };

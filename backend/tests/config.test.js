// backend/tests/config.test.js -- unit tests for the config loader (Req 10.2, 10.3,
// 10.4, 10.9, 10.10).
//
// Every failure path is exercised through the pure `loadConfig`, which never logs and
// never exits, so no test can take the jest worker down with it. `loadOrExit` is
// covered with `process.exit` and `console.error` spied, again without exiting.

const fs = require('fs');
const path = require('path');

const config = require('../src/config');

const { loadConfig, loadOrExit, REQUIRED } = config;

const SRC_DIR = path.join(__dirname, '..', 'src');
const CONFIG_MODULE = path.join('src', 'config', 'index.js');

// A minimal environment every required variable satisfies.
const VALID_ENV = Object.freeze({
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'erp_test',
    MYSQL_PASSWORD: 'not-a-real-password',
    MYSQL_DATABASE: 'mini_operations_erp',
    JWT_SECRET: 'a'.repeat(32),
    PORT: '4000',
    CORS_ORIGIN: 'http://localhost:5173',
});

const envWith = (overrides = {}) => ({ ...VALID_ENV, ...overrides });

/** Removes the named variables entirely (absent rather than blank). */
function envWithout(names) {
    const env = envWith();
    for (const name of names) {
        delete env[name];
    }
    return env;
}

/**
 * Removes comments so a module that merely mentions `process.env` in prose is not
 * reported. Quote state is tracked, so a `//` inside a string (a Database URI, for
 * example) is not mistaken for a comment start.
 */
function stripComments(source) {
    const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, ' ');

    return withoutBlocks
        .split('\n')
        .map((line) => {
            let quote = null;
            for (let i = 0; i < line.length; i += 1) {
                const char = line[i];
                if (quote) {
                    if (char === '\\') {
                        i += 1;
                    } else if (char === quote) {
                        quote = null;
                    }
                } else if (char === '"' || char === "'" || char === '`') {
                    quote = char;
                } else if (char === '/' && line[i + 1] === '/') {
                    return line.slice(0, i);
                }
            }
            return line;
        })
        .join('\n');
}

/** Every .js file under backend/src, recursively, node_modules skipped. */
function listSourceFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

describe('config loader: the exported module', () => {
    test('exposes exactly the resolved values as enumerable keys', () => {
        expect(Object.keys(config).sort()).toEqual([
            'corsOrigin',
            'jwtSecret',
            'mysql',
            'port',
        ]);
        expect(typeof config.port).toBe('number');
        // The MySQL settings are grouped so a caller passes `config.mysql` straight to
        // mysql2's createPool without restating field names.
        expect(Object.keys(config.mysql).sort()).toEqual([
            'database',
            'host',
            'password',
            'port',
            'user',
        ]);
        expect(typeof config.mysql.port).toBe('number');
    });

    test('declares exactly the required variable names', () => {
        expect(REQUIRED).toEqual([
            'MYSQL_HOST',
            'MYSQL_PORT',
            'MYSQL_USER',
            'MYSQL_DATABASE',
            'JWT_SECRET',
            'PORT',
            'CORS_ORIGIN',
            'MYSQL_PASSWORD',
        ]);
        expect(Object.isFrozen(REQUIRED)).toBe(true);
    });

    test('accepts a fully valid environment and resolves its values', () => {
        const result = loadConfig(VALID_ENV);

        expect(result).toEqual({
            ok: true,
            config: {
                mysql: {
                    host: VALID_ENV.MYSQL_HOST,
                    port: Number(VALID_ENV.MYSQL_PORT),
                    user: VALID_ENV.MYSQL_USER,
                    password: VALID_ENV.MYSQL_PASSWORD,
                    database: VALID_ENV.MYSQL_DATABASE,
                },
                jwtSecret: VALID_ENV.JWT_SECRET,
                port: 4000,
                corsOrigin: VALID_ENV.CORS_ORIGIN,
            },
        });
    });
});

describe('config loader: missing and blank required variables (Req 10.2, 10.3)', () => {
    test.each(REQUIRED)('reports %s alone when it is absent', (name) => {
        const result = loadConfig(envWithout([name]));

        expect(result.ok).toBe(false);
        expect(result.errors).toEqual([
            `Missing required environment variables: ${name}`,
        ]);
    });

    test.each([
        ['empty string', ''],
        ['single space', ' '],
        ['whitespace only', '  \t\n '],
    ])('treats a %s value as blank', (_label, blankValue) => {
        const result = loadConfig(envWith({ CORS_ORIGIN: blankValue }));

        expect(result.ok).toBe(false);
        expect(result.errors).toEqual([
            'Missing required environment variables: CORS_ORIGIN',
        ]);
    });

    test('names every blank variable in one message, in declaration order', () => {
        const result = loadConfig(
            envWith({ MYSQL_HOST: '   ', PORT: '', CORS_ORIGIN: undefined })
        );

        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toBe(
            'Missing required environment variables: MYSQL_HOST, PORT, CORS_ORIGIN'
        );
    });

    test('applies no default, so an empty environment fails on all four', () => {
        const result = loadConfig({});

        expect(result.ok).toBe(false);
        expect(result.errors).toEqual([
            `Missing required environment variables: ${REQUIRED.join(', ')}`,
        ]);
    });

    test('reports missing variables first and alone, format errors suppressed', () => {
        const result = loadConfig(
            envWith({ MYSQL_HOST: undefined, PORT: '99999', JWT_SECRET: 'short' })
        );

        expect(result.ok).toBe(false);
        expect(result.errors).toEqual([
            'Missing required environment variables: MYSQL_HOST',
        ]);
    });
});

describe('config loader: PORT value constraints (Req 10.9)', () => {
    test.each(['1', '80', '4000', '65535'])('accepts %s', (portValue) => {
        const result = loadConfig(envWith({ PORT: portValue }));

        expect(result.ok).toBe(true);
        expect(result.config.port).toBe(Number(portValue));
    });

    test.each([
        ['below the range', '0'],
        ['above the range', '65536'],
        ['far above the range', '70000'],
        ['negative', '-1'],
        ['fractional', '40.5'],
        ['hexadecimal', '0x10'],
        ['exponential', '1e3'],
        ['padded with spaces', ' 4000 '],
        ['non-numeric', 'four-thousand'],
        ['plus signed', '+4000'],
    ])('rejects a %s port and names PORT', (_label, portValue) => {
        const result = loadConfig(envWith({ PORT: portValue }));

        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('PORT');
        expect(result.errors[0]).toContain('65535');
    });
});

describe('config loader: JWT_SECRET length constraint (Req 10.10)', () => {
    test('accepts a secret of exactly 32 characters', () => {
        const result = loadConfig(envWith({ JWT_SECRET: 'x'.repeat(32) }));

        expect(result.ok).toBe(true);
        expect(result.config.jwtSecret).toHaveLength(32);
    });

    test.each([1, 8, 31])('rejects a secret of %i characters', (length) => {
        const result = loadConfig(envWith({ JWT_SECRET: 'x'.repeat(length) }));

        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('JWT_SECRET');
        expect(result.errors[0]).toContain('32');
    });

    test('collects the PORT and JWT_SECRET errors together', () => {
        const result = loadConfig(envWith({ PORT: '0', JWT_SECRET: 'too-short' }));

        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(2);
        expect(result.errors.join('\n')).toContain('PORT');
        expect(result.errors.join('\n')).toContain('JWT_SECRET');
    });
});

describe('config loader: startup wrapper', () => {
    let exitSpy;
    let errorSpy;

    beforeEach(() => {
        // Both spied so a failing environment neither prints nor stops the worker.
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test('returns the resolved config and does not exit for a valid environment', () => {
        const resolved = loadOrExit(VALID_ENV);

        expect(resolved).toEqual({
            mysql: {
                host: VALID_ENV.MYSQL_HOST,
                port: Number(VALID_ENV.MYSQL_PORT),
                user: VALID_ENV.MYSQL_USER,
                password: VALID_ENV.MYSQL_PASSWORD,
                database: VALID_ENV.MYSQL_DATABASE,
            },
            jwtSecret: VALID_ENV.JWT_SECRET,
            port: 4000,
            corsOrigin: VALID_ENV.CORS_ORIGIN,
        });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('writes one message to standard error and exits non-zero', () => {
        loadOrExit(envWith({ JWT_SECRET: undefined }));

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(
            'Missing required environment variables: JWT_SECRET'
        );
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(exitSpy.mock.calls[0][0]).not.toBe(0);
    });

    test('joins several format errors into one standard error message', () => {
        loadOrExit(envWith({ PORT: '1e3', JWT_SECRET: 'nope' }));

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const [message] = errorSpy.mock.calls[0];
        expect(message.split('\n')).toHaveLength(2);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe('config loader: single point of environment access (Req 10.4)', () => {
    test('no module outside src/config reads process.env', () => {
        const offenders = listSourceFiles(SRC_DIR)
            .filter((file) =>
                /process\.env/.test(stripComments(fs.readFileSync(file, 'utf8')))
            )
            .map((file) => path.relative(path.join(__dirname, '..'), file))
            .filter((relative) => relative !== CONFIG_MODULE);

        expect(offenders).toEqual([]);
    });

    test('the scan actually covers the source tree and finds the config module', () => {
        const files = listSourceFiles(SRC_DIR).map((file) =>
            path.relative(path.join(__dirname, '..'), file)
        );

        expect(files).toContain(CONFIG_MODULE);
        expect(files).toContain(path.join('src', 'app.js'));
        expect(files).toContain(path.join('src', 'server.js'));
        expect(files.every((file) => !file.includes('node_modules'))).toBe(true);
    });

    test('the comment stripper keeps real reads and drops mentions in prose', () => {
        // Not vacuous: the config module's own reads survive stripping.
        const configSource = fs.readFileSync(path.join(SRC_DIR, 'config', 'index.js'), 'utf8');
        expect(stripComments(configSource)).toMatch(/process\.env/);

        expect(stripComments('// mentions process.env in prose\nconst a = 1;')).not.toMatch(
            /process\.env/
        );
        expect(stripComments('/* process.env */\nconst b = 2;')).not.toMatch(/process\.env/);
        expect(stripComments("const uri = 'mongodb://h'; process.env.PORT;")).toMatch(
            /process\.env/
        );
    });
});

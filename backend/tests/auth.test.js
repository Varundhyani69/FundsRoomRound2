// backend/tests/auth.test.js -- authentication end to end (Req 1.1 - 1.11).
//
// Every assertion is made over HTTP against the exported Express app, so the login
// schema, the auth service, the authenticate middleware and the error handler are all
// inside the test rather than being called directly (Req 12.13).

const express = require('express');
const { User } = require('./setup/tables');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const authenticate = require('../src/middleware/authenticate');
const errorHandler = require('../src/middleware/errorHandler');
const { agent } = require('./setup/agent');
const { FIXTURE_USERS, FIXTURE_LOCATIONS } = require('./setup/seedFixture');

const LOGIN = '/api/auth/login';
const admin = FIXTURE_USERS.Admin;

// Increment 2 declares no protected route on the real app yet -- /api/auth/login is the
// only path, and an unmatched /api path is a 404 by design. So the four token states are
// exercised against the real `authenticate` and the real `errorHandler` mounted on a
// stub route here. `reached: true` in a body means the handler ran, which every rejected
// token must not do (Req 1.8, 1.9).
const protectedApp = express();
protectedApp.get('/protected', authenticate, (req, res) => {
    res.status(200).json({ reached: true, user: req.user });
});
protectedApp.use(errorHandler);

const protectedRequest = (token) => {
    const pending = request(protectedApp).get('/protected');
    return token === undefined ? pending : pending.set('Authorization', token);
};

describe('POST /api/auth/login -- accepted credentials (Req 1.1, 1.6)', () => {
    test('returns a token and the caller identity without the password hash', async () => {
        const response = await agent()
            .post(LOGIN)
            .send({ email: admin.email, password: admin.password });

        expect(response.status).toBe(200);
        expect(typeof response.body.token).toBe('string');
        expect(response.body.user).toEqual({
            id: admin.id,
            email: admin.email,
            role: 'Admin',
            assignedLocation: null,
        });

        // The stored hash must not reach the client under any key name (Req 1.1).
        const stored = await User.findById(admin.id).select('+passwordHash');
        expect(response.text).not.toContain(stored.passwordHash);
        expect(response.text).not.toContain(admin.password);
        expect(response.body.user).not.toHaveProperty('passwordHash');
    });

    test('matches the email after trimming and lowercasing it (Req 1.1)', async () => {
        const response = await agent()
            .post(LOGIN)
            .send({ email: `  ${admin.email.toUpperCase()}  `, password: admin.password });

        expect(response.status).toBe(200);
        expect(response.body.user.email).toBe(admin.email);
    });

    test('reports the assigned location of the caller (Req 1.1)', async () => {
        const ops = FIXTURE_USERS.OperationsUser;
        // A real fixture Location, not a freshly generated id: under MongoDB any well-formed
        // ObjectId would store, but users.assigned_location_id is now a foreign key into
        // locations, so an id naming no location is refused by the database -- which is the
        // point of the constraint.
        const locationId = FIXTURE_LOCATIONS.main.id;
        await User.updateOne({ _id: ops.id }, { assignedLocation: locationId });

        const response = await agent()
            .post(LOGIN)
            .send({ email: ops.email, password: ops.password });

        expect(response.status).toBe(200);
        expect(response.body.user.assignedLocation).toBe(String(locationId));
    });
});

describe('POST /api/auth/login -- rejected credentials (Req 1.2, 1.3, 1.4, 1.10)', () => {
    // Read every User exactly as stored, so "leave every User document unchanged" can be
    // compared field by field rather than by document count alone.
    const snapshotUsers = () =>
        User.find({}).select('+passwordHash').sort({ email: 1 }).lean();

    test('an unmatched email and a wrong password are indistinguishable', async () => {
        const before = await snapshotUsers();

        const unknownEmail = await agent()
            .post(LOGIN)
            .send({ email: 'nobody@fixture.test', password: admin.password });
        const wrongPassword = await agent()
            .post(LOGIN)
            .send({ email: admin.email, password: 'definitely-not-the-password' });

        expect(unknownEmail.status).toBe(401);
        expect(unknownEmail.body).toEqual({
            code: 'INVALID_CREDENTIALS',
            message: expect.any(String),
        });

        // Identical status, code and message, so the response cannot be used to learn
        // which email addresses exist (Req 1.4).
        expect(wrongPassword.status).toBe(unknownEmail.status);
        expect(wrongPassword.body).toEqual(unknownEmail.body);

        // No token issued by either branch, and nothing written (Req 1.2, 1.3).
        expect(unknownEmail.body).not.toHaveProperty('token');
        expect(wrongPassword.body).not.toHaveProperty('token');
        expect(await snapshotUsers()).toEqual(before);
    });
});

describe('stored passwords (Req 1.5)', () => {
    test('are bcrypt hashes with a cost factor of 10 to 12 and no plaintext', async () => {
        const stored = await User.find({}).select('+passwordHash').lean();
        expect(stored).toHaveLength(3);

        for (const document of stored) {
            const match = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(document.passwordHash);
            expect(match).not.toBeNull();

            const cost = Number(match[1]);
            expect(cost).toBeGreaterThanOrEqual(10);
            expect(cost).toBeLessThanOrEqual(12);

            // The hash is the only representation of the password on the document.
            const plaintext = Object.values(FIXTURE_USERS).find(
                (user) => user.email === document.email
            ).password;
            expect(JSON.stringify(document)).not.toContain(plaintext);
            expect(await bcrypt.compare(plaintext, document.passwordHash)).toBe(true);
        }
    });
});

describe('issued tokens (Req 1.6)', () => {
    test('carry the user identifier and role and expire 8 hours after issuance', async () => {
        const response = await agent()
            .post(LOGIN)
            .send({ email: admin.email, password: admin.password });

        expect(response.status).toBe(200);

        // Verified against the configured secret, so the signature is the one the
        // authenticate middleware will accept.
        const claims = jwt.verify(response.body.token, config.jwtSecret);
        expect(claims.sub).toBe(admin.id);
        expect(claims.role).toBe('Admin');
        expect(claims.exp - claims.iat).toBe(8 * 60 * 60);
    });
});

describe('a protected route (Req 1.7, 1.8, 1.9)', () => {
    const signWith = (secret, options) =>
        jwt.sign({ sub: admin.id, role: 'Admin' }, secret, options);

    test('accepts a valid token and attaches only the id and role', async () => {
        const response = await protectedRequest(`Bearer ${signWith(config.jwtSecret, { expiresIn: '8h' })}`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            reached: true,
            user: { id: admin.id, role: 'Admin' },
        });
    });

    test.each([
        ['no token at all', undefined],
        ['an undecodable token', 'Bearer not-a-json-web-token'],
        ['a token signed with another secret', () => `Bearer ${signWith('a-different-secret-of-at-least-32-chars')}`],
        ['an expired token', () => `Bearer ${signWith(config.jwtSecret, { expiresIn: '-1s' })}`],
    ])('rejects %s with 401 UNAUTHENTICATED', async (_label, header) => {
        const response = await protectedRequest(
            typeof header === 'function' ? header() : header
        );

        expect(response.status).toBe(401);
        expect(response.body).toEqual({
            code: 'UNAUTHENTICATED',
            message: expect.any(String),
        });
        // The route handler never ran (Req 1.8, 1.9).
        expect(response.body).not.toHaveProperty('reached');
    });
});

describe('POST /api/auth/login -- rejected requests (Req 1.11)', () => {
    test.each([
        ['a missing email', { password: admin.password }],
        ['a missing password', { email: admin.email }],
        ['a blank email', { email: '   ', password: admin.password }],
        ['a blank password', { email: admin.email, password: '   ' }],
        ['an over-long email', { email: `${'a'.repeat(243)}@fixture.test`, password: admin.password }],
        ['an over-long password', { email: admin.email, password: 'p'.repeat(73) }],
    ])('rejects %s with 400 VALIDATION_ERROR and issues no token', async (_label, body) => {
        const response = await agent().post(LOGIN).send(body);

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(response.body).not.toHaveProperty('token');
        // One details entry naming the rejected field (Req 9.4).
        expect(response.body.details.length).toBeGreaterThanOrEqual(1);
    });
});

// backend/tests/userModel.test.js -- the User schema itself: email normalization and
// uniqueness, the hidden password hash, the Role enum, and the nullable
// Assigned_Location (Req 1.1, 1.5, 15.4).

const mongoose = require('mongoose');

const User = require('../src/models/User');

// The collection is created lazily, so the unique index has to be built before the
// duplicate-email test can rely on it. Indexes survive the per-test document reset.
beforeAll(async () => {
    await User.syncIndexes();
});

describe('User model', () => {
    test('stores email trimmed and lowercased', async () => {
        const user = await User.create({
            email: '  Admin@Example.COM  ',
            passwordHash: 'not-a-real-hash',
            role: 'Admin',
        });

        expect(user.email).toBe('admin@example.com');
    });

    test('rejects a second User with the same normalized email', async () => {
        await User.create({
            email: 'ops@example.com',
            passwordHash: 'not-a-real-hash',
            role: 'OperationsUser',
        });

        await expect(
            User.create({
                email: 'OPS@example.com',
                passwordHash: 'another-hash',
                role: 'SalesUser',
            })
        ).rejects.toMatchObject({ code: 11000 });

        // Scoped to this email: the per-test seed fixture also holds Users (Req 12.11).
        expect(await User.countDocuments({ email: 'ops@example.com' })).toBe(1);
    });

    test('excludes passwordHash from a read unless it is explicitly selected', async () => {
        await User.create({
            email: 'sales@example.com',
            passwordHash: 'hash-to-hide',
            role: 'SalesUser',
        });

        const listed = await User.find({ email: 'sales@example.com' });
        expect(listed).toHaveLength(1);
        expect(listed[0].passwordHash).toBeUndefined();
        expect(JSON.stringify(listed[0])).not.toContain('hash-to-hide');

        const withHash = await User.findOne({ email: 'sales@example.com' }).select('+passwordHash');
        expect(withHash.passwordHash).toBe('hash-to-hide');
    });

    test('defaults assignedLocation to null and keeps an assigned reference', async () => {
        const unassigned = await User.create({
            email: 'admin@example.com',
            passwordHash: 'not-a-real-hash',
            role: 'Admin',
        });
        expect(unassigned.assignedLocation).toBeNull();
        expect(unassigned.createdAt).toBeInstanceOf(Date);
        expect(unassigned.updatedAt).toBeInstanceOf(Date);

        const locationId = new mongoose.Types.ObjectId();
        const assigned = await User.create({
            email: 'ops@example.com',
            passwordHash: 'not-a-real-hash',
            role: 'OperationsUser',
            assignedLocation: locationId,
        });
        expect(assigned.assignedLocation.equals(locationId)).toBe(true);
    });

    test('rejects a role outside the enum, a missing hash, and an over-long email', async () => {
        await expect(
            User.create({ email: 'x@example.com', passwordHash: 'h', role: 'Superuser' })
        ).rejects.toThrow(mongoose.Error.ValidationError);

        await expect(User.create({ email: 'y@example.com', role: 'Admin' })).rejects.toThrow(
            mongoose.Error.ValidationError
        );

        const longEmail = `${'a'.repeat(243)}@example.com`; // 255 characters
        expect(longEmail).toHaveLength(255);
        await expect(
            User.create({ email: longEmail, passwordHash: 'h', role: 'Admin' })
        ).rejects.toThrow(mongoose.Error.ValidationError);

        // None of the three rejected documents was written; the seeded fixture Users are
        // outside this filter.
        expect(
            await User.countDocuments({
                email: { $in: ['x@example.com', 'y@example.com', longEmail] },
            })
        ).toBe(0);
    });
});

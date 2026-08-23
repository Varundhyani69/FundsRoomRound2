// frontend/src/auth/AuthContext.test.jsx -- permanent component tests for
// AuthContext.jsx.
//
// This file exists specifically because a real bug slipped through
// unnoticed until manual browser testing: login() read response.id /
// response.email / response.role / response.assignedLocation directly off
// the top-level login response, but the API actually nests all four fields
// under response.user (backend/src/services/auth.service.js's documented
// return shape: `{ token, user: { id, email, role, assignedLocation } }`).
// That meant `role` was always undefined after a real login, so every
// canWrite() check in every screen silently returned false and no
// write control ever appeared for any role, including Admin.
//
// Every other test file that touches AuthContext mocks useAuth() entirely
// (LoginScreen.test.jsx, WorkOrdersScreen.test.jsx, etc.), so none of them
// ever executed the real login() function body against a realistic response
// shape. This file renders the real AuthProvider and asserts against the
// real backend response shape so a similar mismatch cannot land unnoticed
// again.

import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { post, getToken, getUser, clearToken, clearUser } from '../api/client.js';

vi.mock('../api/client.js', () => import('../test/mockApiClient.js'));

// The exact shape backend/src/services/auth.service.js documents and
// backend/src/controllers/auth.controller.js returns as the 200 body of
// POST /api/auth/login.
const LOGIN_RESPONSE = {
    token: 'signed.jwt.token',
    user: {
        id: 'user-1',
        email: 'admin@mini-erp.local',
        role: 'Admin',
        assignedLocation: null,
    },
};

// A small probe component that calls login() and renders whatever useAuth()
// currently reports, so assertions can read the resulting context value
// without reaching into AuthProvider's internals.
function Probe({ onReady }) {
    const auth = useAuth();
    useEffect(() => {
        onReady(auth);
    }, [auth]);
    return (
        <div>
            <div data-testid="role">{auth.role ?? 'null'}</div>
            <div data-testid="email">{auth.user?.email ?? 'null'}</div>
            <div data-testid="token">{auth.token ?? 'null'}</div>
            <button
                type="button"
                onClick={() => {
                    // Every real caller (LoginScreen.jsx) awaits login() inside a
                    // try/catch; this probe does the same so a rejected login
                    // (asserted separately below) never becomes an unhandled
                    // promise rejection here.
                    auth.login('admin@mini-erp.local', 'secret123').catch(() => { });
                }}
            >
                Log in
            </button>
        </div>
    );
}

describe('AuthContext', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getToken.mockReturnValue(null);
        getUser.mockReturnValue(null);
    });

    test('login() reads id/email/role/assignedLocation from the nested user object, not the top level', async () => {
        post.mockResolvedValueOnce(LOGIN_RESPONSE);

        render(
            <AuthProvider>
                <Probe onReady={() => { }} />
            </AuthProvider>
        );

        expect(screen.getByTestId('role')).toHaveTextContent('null');

        screen.getByRole('button', { name: 'Log in' }).click();

        // The regression this guards against: role stayed undefined/null
        // forever because login() read response.role instead of
        // response.user.role, so this specifically asserts the *resolved*
        // role and email, not just that login() resolved without throwing.
        await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('Admin'));
        expect(screen.getByTestId('email')).toHaveTextContent('admin@mini-erp.local');
        expect(screen.getByTestId('token')).toHaveTextContent('signed.jwt.token');
    });

    test('login() persists the same nested-object fields via setToken/setUser', async () => {
        post.mockResolvedValueOnce(LOGIN_RESPONSE);

        render(
            <AuthProvider>
                <Probe onReady={() => { }} />
            </AuthProvider>
        );

        screen.getByRole('button', { name: 'Log in' }).click();

        await waitFor(() => expect(screen.getByTestId('role')).toHaveTextContent('Admin'));

        const { setToken, setUser } = await import('../api/client.js');
        expect(setToken).toHaveBeenCalledWith('signed.jwt.token');
        expect(setUser).toHaveBeenCalledWith({
            id: 'user-1',
            email: 'admin@mini-erp.local',
            role: 'Admin',
            assignedLocation: null,
        });
    });

    test('a rejected login leaves role/token unset', async () => {
        const { ApiError } = await import('../test/mockApiClient.js');
        post.mockRejectedValueOnce(new ApiError('INVALID_CREDENTIALS', 'Email or password is incorrect.'));

        render(
            <AuthProvider>
                <Probe onReady={() => { }} />
            </AuthProvider>
        );

        screen.getByRole('button', { name: 'Log in' }).click();

        await waitFor(() => expect(post).toHaveBeenCalled());
        expect(screen.getByTestId('role')).toHaveTextContent('null');
        expect(screen.getByTestId('token')).toHaveTextContent('null');
    });
});

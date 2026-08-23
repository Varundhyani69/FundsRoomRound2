// frontend/src/screens/LoginScreen.test.jsx -- permanent component tests
// for LoginScreen.jsx (task 10.11), replacing the throwaway test written
// during task 10.5. Extended when the hardcoded demo-credentials table was
// replaced by the build-time opt-in DemoCredentials panel, so the tests now
// also pin the security-relevant default: no VITE_DEMO_* variable set means
// no panel and no password anywhere on the screen.
//
// useAuth() is mocked directly since LoginScreen only needs `login` from
// it; react-router-dom's useNavigate is mocked so navigation can be
// asserted without a real router.
//
// Both spies come from vi.hoisted rather than being created inside the
// vi.mock factories: renderLogin() below re-evaluates the module graph, which
// re-runs those factories, and a factory that called vi.fn() itself would hand
// the freshly imported screen a spy these tests never wired up.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockLogin, mockNavigate } = vi.hoisted(() => ({
    mockLogin: vi.fn(),
    mockNavigate: vi.fn(),
}));

vi.mock('../auth/AuthContext.jsx', () => ({
    useAuth: () => ({ login: mockLogin }),
}));

vi.mock('react-router-dom', () => ({
    useNavigate: () => mockNavigate,
}));

/**
 * Renders the screen with the demo-panel build variables set to the given values,
 * defaulting to all three absent.
 *
 * DemoCredentials reads import.meta.env once at module scope (the values are
 * substituted at build time in a real build), so the module has to be re-evaluated
 * after the stubs are in place -- a top-level import would freeze whatever the
 * developer's own frontend/.env happens to contain and make the suite
 * machine-dependent. Empty string stands in for "variable absent": the component
 * treats both the same way, and an empty stub is what a build arg left unset in
 * Docker produces anyway.
 */
async function renderLogin({ admin = '', ops = '', sales = '' } = {}) {
    vi.stubEnv('VITE_DEMO_ADMIN_PASSWORD', admin);
    vi.stubEnv('VITE_DEMO_OPS_PASSWORD', ops);
    vi.stubEnv('VITE_DEMO_SALES_PASSWORD', sales);
    vi.resetModules();
    const { default: LoginScreen } = await import('./LoginScreen.jsx');
    render(<LoginScreen />);
}

describe('LoginScreen', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    test('renders the login form', async () => {
        await renderLogin();
        expect(screen.getByLabelText('Email')).toBeInTheDocument();
        expect(screen.getByLabelText('Password')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    });

    test('submitting valid credentials calls login and navigates to Inventory', async () => {
        mockLogin.mockResolvedValue(true);
        await renderLogin();

        fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('admin@example.com', 'secret123'));
        expect(mockNavigate).toHaveBeenCalledWith('/inventory');
    });

    test('submitting invalid credentials shows the error message and retains the email', async () => {
        mockLogin.mockRejectedValue(new Error('Invalid email or password.'));
        await renderLogin();

        fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bad@example.com' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpass' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password.'));
        expect(screen.getByLabelText('Email')).toHaveValue('bad@example.com');
        expect(mockNavigate).not.toHaveBeenCalled();
    });

    test('disables the submit button while the request is in flight', async () => {
        let resolveLogin;
        mockLogin.mockReturnValue(
            new Promise((resolve) => {
                resolveLogin = resolve;
            })
        );
        await renderLogin();

        fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();

        resolveLogin(true);

        await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/inventory'));
    });

    describe('demo account panel', () => {
        // The values below are deliberately not any deployment's real seeded
        // passwords: the point of the rewrite is that no password value lives in a
        // tracked file (Req 13.8), and a test file is a tracked file.
        const STUB_ADMIN_PW = 'stub-admin-pw';
        const STUB_OPS_PW = 'stub-ops-pw';

        test('renders nothing when no demo password was set at build time', async () => {
            await renderLogin();

            expect(screen.queryByText('Demo accounts')).not.toBeInTheDocument();
            expect(screen.queryByText(/admin@mini-erp\.local/)).not.toBeInTheDocument();
            // Sign in is the only button on the screen, so no click-to-fill control
            // slipped through with an empty password behind it.
            expect(screen.getAllByRole('button')).toHaveLength(1);
        });

        test('a demo account button fills the form with that role password without submitting', async () => {
            await renderLogin({ admin: STUB_ADMIN_PW });

            fireEvent.click(screen.getByRole('button', { name: /admin@mini-erp\.local/ }));

            expect(screen.getByLabelText('Email')).toHaveValue('admin@mini-erp.local');
            expect(screen.getByLabelText('Password')).toHaveValue(STUB_ADMIN_PW);
            // Req 11.2 is exercised by the reviewer pressing Sign in, so picking an
            // account must not authenticate on its own.
            expect(mockLogin).not.toHaveBeenCalled();
            expect(mockNavigate).not.toHaveBeenCalled();
        });

        test('omits the roles whose password was not set at build time', async () => {
            await renderLogin({ admin: STUB_ADMIN_PW });

            expect(screen.getByRole('button', { name: /admin@mini-erp\.local/ })).toBeInTheDocument();
            expect(screen.queryByText(/operations@mini-erp\.local/)).not.toBeInTheDocument();
            expect(screen.queryByText(/sales@mini-erp\.local/)).not.toBeInTheDocument();
        });

        test('picking a demo account clears a previous rejection message', async () => {
            mockLogin.mockRejectedValue(new Error('Invalid email or password.'));
            await renderLogin({ ops: STUB_OPS_PW });

            fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bad@example.com' } });
            fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpass' } });
            fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
            await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

            fireEvent.click(screen.getByRole('button', { name: /operations@mini-erp\.local/ }));

            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
            expect(screen.getByLabelText('Email')).toHaveValue('operations@mini-erp.local');
            expect(screen.getByLabelText('Password')).toHaveValue(STUB_OPS_PW);
        });
    });
});

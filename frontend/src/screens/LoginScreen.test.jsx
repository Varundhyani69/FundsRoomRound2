// frontend/src/screens/LoginScreen.test.jsx -- permanent component tests
// for LoginScreen.jsx (task 10.11), replacing the throwaway test written
// during task 10.5.
//
// useAuth() is mocked directly since LoginScreen only needs `login` from
// it; react-router-dom's useNavigate is mocked so navigation can be
// asserted without a real router.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginScreen from './LoginScreen.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

vi.mock('../auth/AuthContext.jsx', () => ({
    useAuth: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
    useNavigate: () => mockNavigate,
}));

describe('LoginScreen', () => {
    let mockLogin;

    beforeEach(() => {
        vi.clearAllMocks();
        mockLogin = vi.fn();
        useAuth.mockReturnValue({ login: mockLogin });
    });

    test('renders the login form', () => {
        render(<LoginScreen />);
        expect(screen.getByLabelText('Email')).toBeInTheDocument();
        expect(screen.getByLabelText('Password')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    });

    test('submitting valid credentials calls login and navigates to Inventory', async () => {
        mockLogin.mockResolvedValue(true);
        render(<LoginScreen />);

        fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('admin@example.com', 'secret123'));
        expect(mockNavigate).toHaveBeenCalledWith('/inventory');
    });

    test('submitting invalid credentials shows the error message and retains the email', async () => {
        mockLogin.mockRejectedValue(new Error('Invalid email or password.'));
        render(<LoginScreen />);

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
        render(<LoginScreen />);

        fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();

        resolveLogin(true);

        await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/inventory'));
    });
});

// frontend/src/screens/LoginScreen.jsx -- the only screen rendered before
// authentication. Submits credentials via useAuth().login and navigates to
// Inventory on success (Req 11.2). On rejection, keeps the screen displayed,
// stores nothing (login() throws before AuthContext stores anything),
// retains the submitted email, and shows the rejection message (Req 11.16).
// Disables the submit control while the request is in flight (Req 11.13).

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function LoginScreen() {
    const { login } = useAuth();
    const navigate = useNavigate();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit(event) {
        event.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            await login(email, password);
            navigate('/inventory');
        } catch (err) {
            // Req 11.16: email is left as-is (not cleared) so the User does
            // not have to retype it. The password is cleared since nothing
            // requires it to be retained and leaving a rejected password
            // sitting in the field has no upside.
            setPassword('');
            setError(err.message);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <main>
            <h1>Login</h1>
            <form onSubmit={handleSubmit}>
                <div>
                    <label htmlFor="login-email">Email</label>
                    <input
                        id="login-email"
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        autoComplete="username"
                        required
                    />
                </div>
                <div>
                    <label htmlFor="login-password">Password</label>
                    <input
                        id="login-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                        required
                    />
                </div>
                {error && <p role="alert">{error}</p>}
                <button type="submit" disabled={submitting}>
                    {submitting ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </main>
    );
}

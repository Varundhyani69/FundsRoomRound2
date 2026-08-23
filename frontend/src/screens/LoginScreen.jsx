// frontend/src/screens/LoginScreen.jsx -- the only screen rendered before
// authentication. Submits credentials via useAuth().login and navigates to
// Inventory on success (Req 11.2). On rejection, keeps the screen displayed,
// stores nothing (login() throws before AuthContext stores anything),
// retains the submitted email, and shows the rejection message (Req 11.16).
// Disables the submit control while the request is in flight (Req 11.13).
//
// The demo-account panel below the form is build-time opt-in: DemoCredentials
// renders nothing unless the VITE_DEMO_*_PASSWORD variables were set when the
// bundle was built. A normal build therefore ships no credentials at all, and no
// password value has to live in a tracked file (Req 13.8) -- which also means the
// panel cannot go stale against a deployment whose seeded passwords differ.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import DemoCredentials from '../components/DemoCredentials.jsx';

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
        <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
            <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
                <h1 className="mb-1 text-xl font-semibold text-slate-900">Mini Operations ERP</h1>
                <p className="mb-6 text-sm text-slate-500">Sign in to continue</p>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label htmlFor="login-email" className="mb-1 block text-sm font-medium text-slate-700">
                            Email
                        </label>
                        <input
                            id="login-email"
                            type="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            autoComplete="username"
                            required
                            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                    </div>
                    <div>
                        <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-slate-700">
                            Password
                        </label>
                        <input
                            id="login-password"
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete="current-password"
                            required
                            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                    </div>
                    {error && (
                        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                            {error}
                        </p>
                    )}
                    <button
                        type="submit"
                        disabled={submitting}
                        className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {submitting ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>

                <DemoCredentials
                    onPick={(demoEmail, demoPassword) => {
                        // Fills the fields instead of submitting, so the reviewer sees
                        // which account is about to be used and presses Sign in.
                        setEmail(demoEmail);
                        setPassword(demoPassword);
                        // A stale rejection message next to freshly filled credentials
                        // would look like the new pick had already failed.
                        setError(null);
                    }}
                />
            </div>
        </main>
    );
}

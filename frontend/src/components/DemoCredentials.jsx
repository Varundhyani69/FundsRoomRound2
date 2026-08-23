// frontend/src/components/DemoCredentials.jsx -- a click-to-fill panel on the
// Login screen listing the seeded accounts, so a reviewer can sign in as each
// role without being handed a password separately.
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE ENABLING IT
// ---------------------------------------------------------------------------
// This panel puts a working password into the shipped JavaScript bundle. Anyone
// who can load the page can therefore sign in as Admin and write data. That is
// acceptable for a throwaway review deployment seeded with sample rows, and it is
// NOT acceptable for anything holding real data.
//
// It is opt-in for exactly that reason: the panel renders only when
// VITE_DEMO_PASSWORD is set at BUILD time. Leave the variable unset and this
// component returns null, so a local `npm run dev` and any normal build show no
// credentials at all. There is no runtime switch, because a build without the
// variable does not contain the password to begin with -- which is a stronger
// guarantee than a flag someone can flip.
//
// The three emails are the fixed addresses backend/scripts/seed.js creates. The
// password is shared across all three, so set SEED_ADMIN_PASSWORD,
// SEED_OPS_PASSWORD and SEED_SALES_PASSWORD to the same value as
// VITE_DEMO_PASSWORD when you seed that deployment, or the buttons will fill a
// password the server rejects.

// Substituted at build time by Vite. `undefined` when the variable was absent.
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD;

// Mirrors SEED_USERS in backend/scripts/seed.js. The descriptions say what each
// role can do, so the panel doubles as an explanation of the authorization model
// rather than being only a convenience.
const DEMO_ACCOUNTS = [
    {
        role: 'Admin',
        email: 'admin@mini-erp.local',
        can: 'everything',
    },
    {
        role: 'Operations',
        email: 'operations@mini-erp.local',
        can: 'inventory, transfers, work order status',
    },
    {
        role: 'Sales',
        email: 'sales@mini-erp.local',
        can: 'customer orders, plus read-only everywhere',
    },
];

/**
 * @param {{ onPick: (email: string, password: string) => void }} props
 *   `onPick` fills the login form rather than submitting it, so the reviewer still
 *   sees which credentials went in and presses Sign in themselves.
 */
export default function DemoCredentials({ onPick }) {
    if (typeof DEMO_PASSWORD !== 'string' || DEMO_PASSWORD === '') {
        return null;
    }

    return (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                Demo accounts
            </p>
            <p className="mt-1 text-xs text-amber-800">
                Sample deployment. Pick a role to fill the form, then press Sign in.
            </p>
            <ul className="mt-3 space-y-1.5">
                {DEMO_ACCOUNTS.map((account) => (
                    <li key={account.email}>
                        <button
                            type="button"
                            onClick={() => onPick(account.email, DEMO_PASSWORD)}
                            className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-left text-xs text-slate-700 transition-colors hover:border-amber-400 hover:bg-amber-100"
                        >
                            <span className="font-medium text-slate-900">{account.role}</span>
                            <span className="text-slate-400"> · </span>
                            <span className="font-mono">{account.email}</span>
                            <span className="mt-0.5 block text-slate-500">
                                Can write: {account.can}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

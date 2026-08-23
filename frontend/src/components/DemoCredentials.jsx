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
// It is opt-in for exactly that reason: the panel renders only when at least one
// of VITE_DEMO_ADMIN_PASSWORD, VITE_DEMO_OPS_PASSWORD and VITE_DEMO_SALES_PASSWORD
// is set at BUILD time. Leave all three unset and this component returns null, so
// a local `npm run dev` and any normal build show no credentials at all. There is
// no runtime switch, because a build without the variables does not contain the
// passwords to begin with -- which is a stronger guarantee than a flag someone can
// flip.
//
// The three emails are the fixed addresses backend/scripts/seed.js creates. Each
// role has its own password, so set VITE_DEMO_ADMIN_PASSWORD, VITE_DEMO_OPS_PASSWORD
// and VITE_DEMO_SALES_PASSWORD to the same values as the SEED_ADMIN_PASSWORD,
// SEED_OPS_PASSWORD and SEED_SALES_PASSWORD used to seed that deployment, or the
// buttons will fill a password the server rejects.
//
// Setting only some of them is legitimate -- a role whose password is absent is
// simply omitted from the list, rather than shown with a button that fills an empty
// password field and produces a confusing 401.

// Substituted at build time by Vite. `undefined` when the variables were absent.
// Three separate passwords since the seed script allows each role's password to differ.
const DEMO_ADMIN_PW = import.meta.env.VITE_DEMO_ADMIN_PASSWORD;
const DEMO_OPS_PW = import.meta.env.VITE_DEMO_OPS_PASSWORD;
const DEMO_SALES_PW = import.meta.env.VITE_DEMO_SALES_PASSWORD;

// True when at least one demo password was provided at build time.
const ENABLED = Boolean(DEMO_ADMIN_PW || DEMO_OPS_PW || DEMO_SALES_PW);

// Mirrors SEED_USERS in backend/scripts/seed.js. The descriptions say what each
// role can do, so the panel doubles as an explanation of the authorization model
// rather than being only a convenience.
const DEMO_ACCOUNTS = [
    {
        role: 'Admin',
        email: 'admin@mini-erp.local',
        password: DEMO_ADMIN_PW,
        can: 'everything',
    },
    {
        role: 'Operations',
        email: 'operations@mini-erp.local',
        password: DEMO_OPS_PW,
        can: 'inventory, transfers, work order status',
    },
    {
        role: 'Sales',
        email: 'sales@mini-erp.local',
        password: DEMO_SALES_PW,
        can: 'customer orders, plus read-only everywhere',
    },
];

/**
 * @param {{ onPick: (email: string, password: string) => void }} props
 *   `onPick` fills the login form rather than submitting it, so the reviewer still
 *   sees which credentials went in and presses Sign in themselves.
 */
export default function DemoCredentials({ onPick }) {
    // ENABLED is decided at build time, so this is not a feature flag that can be
    // flipped in the browser: a build made without the variables has no password to
    // reveal in the first place.
    if (!ENABLED) {
        return null;
    }

    // A build may legitimately set only one or two of the three variables. Dropping
    // the unset roles here keeps a partially configured build honest -- three buttons
    // where two fill an empty password field would read as a broken login rather than
    // as a missing build variable.
    const availableAccounts = DEMO_ACCOUNTS.filter(
        (account) => typeof account.password === 'string' && account.password !== ''
    );

    return (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                Demo accounts
            </p>
            <p className="mt-1 text-xs text-amber-800">
                Sample deployment. Pick a role to fill the form, then press Sign in.
            </p>
            <ul className="mt-3 space-y-1.5">
                {availableAccounts.map((account) => (
                    <li key={account.email}>
                        <button
                            type="button"
                            // That account's own password, not a shared one: the seed
                            // script gives each role a separate password.
                            onClick={() => onPick(account.email, account.password)}
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

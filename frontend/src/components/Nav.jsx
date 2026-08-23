// frontend/src/components/Nav.jsx -- navigation links to the four
// protected screens (Inventory, Work Orders, Transfers, Orders). Login has
// no nav entry, since you are not logged in yet when you'd need it.
//
// Every valid Role can read every screen (the backend's read-route policy
// admits any authenticated Role -- see authorize.js), so once logged in all
// four links are always shown. Req 2.9's "hide navigation entries ... for
// operations the role isn't permitted to perform" is about write actions,
// not read-only screen visibility, and those are role-gated with canWrite
// INSIDE each screen (forms, buttons), not here.
//
// Req 2.10 ("while holding no confirmed role, render only the Login
// screen") is what this component satisfies: with no token, it renders
// nothing at all, so no nav entry appears before login.

import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const LINK_BASE =
    'rounded-md px-3 py-2 text-sm font-medium transition-colors';
const LINK_INACTIVE = 'text-slate-600 hover:bg-slate-100 hover:text-slate-900';
const LINK_ACTIVE = 'bg-brand-50 text-brand-700';

function linkClassName({ isActive }) {
    return `${LINK_BASE} ${isActive ? LINK_ACTIVE : LINK_INACTIVE}`;
}

export default function Nav() {
    const { token, user, logout } = useAuth();

    if (!token) {
        return null;
    }

    return (
        <nav className="border-b border-slate-200 bg-white shadow-sm">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
                <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-4 text-base font-semibold tracking-tight text-slate-900">
                        Mini Operations ERP
                    </span>
                    <NavLink to="/inventory" className={linkClassName}>
                        Inventory
                    </NavLink>
                    <NavLink to="/work-orders" className={linkClassName}>
                        Work Orders
                    </NavLink>
                    <NavLink to="/transfers" className={linkClassName}>
                        Transfers
                    </NavLink>
                    <NavLink to="/orders" className={linkClassName}>
                        Customer Orders
                    </NavLink>
                </div>
                <div className="flex items-center gap-3">
                    {user && (
                        <span className="text-sm text-slate-500">
                            {user.email} <span className="text-slate-400">·</span> {user.role}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={logout}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                        Sign out
                    </button>
                </div>
            </div>
        </nav>
    );
}

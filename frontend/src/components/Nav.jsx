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

export default function Nav() {
    const { token } = useAuth();

    if (!token) {
        return null;
    }

    return (
        <nav>
            <NavLink to="/inventory">Inventory</NavLink>
            <NavLink to="/work-orders">Work Orders</NavLink>
            <NavLink to="/transfers">Transfers</NavLink>
            <NavLink to="/orders">Customer Orders</NavLink>
        </nav>
    );
}

// frontend/src/components/RequireAuth.jsx -- the route guard wrapping every
// screen except Login (design.md App.jsx routing block).
//
// No token -> redirect to /login and render nothing else, so the guarded
// screen's own useEffect never mounts and never fires its list request
// (Req 11.17: "issue no API request for the requested screen").
// Token present -> render the nested route via <Outlet />.

import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function RequireAuth() {
    const { token } = useAuth();

    if (!token) {
        return <Navigate to="/login" replace />;
    }

    return <Outlet />;
}

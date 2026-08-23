// frontend/src/App.jsx -- the real router: exactly five screens, no sixth
// (Req 11.1), plus a catch-all redirect. Follows design.md's routing block.
//
// The four non-Login screens are nested under RequireAuth, which renders
// the Login screen (via redirect) and issues no API request when no token
// is held (Req 11.17). AuthProvider wraps everything so useAuth() works
// anywhere below it, including inside RequireAuth and Nav.

import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Nav from './components/Nav.jsx';
import LoginScreen from './screens/LoginScreen.jsx';
import InventoryScreen from './screens/InventoryScreen.jsx';
import WorkOrdersScreen from './screens/WorkOrdersScreen.jsx';
import TransfersScreen from './screens/TransfersScreen.jsx';
import CustomerOrdersScreen from './screens/CustomerOrdersScreen.jsx';

export default function App() {
    return (
        <AuthProvider>
            <div className="min-h-screen bg-slate-50">
                <Nav />
                <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
                    <Routes>
                        <Route path="/login" element={<LoginScreen />} />
                        <Route element={<RequireAuth />}>
                            <Route path="/inventory" element={<InventoryScreen />} />
                            <Route path="/work-orders" element={<WorkOrdersScreen />} />
                            <Route path="/transfers" element={<TransfersScreen />} />
                            <Route path="/orders" element={<CustomerOrdersScreen />} />
                        </Route>
                        <Route path="*" element={<Navigate to="/inventory" replace />} />
                    </Routes>
                </div>
            </div>
        </AuthProvider>
    );
}

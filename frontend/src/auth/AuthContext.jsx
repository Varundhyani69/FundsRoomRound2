// frontend/src/auth/AuthContext.jsx -- the one place the app keeps "who is
// logged in" state. Small on purpose (design.md "Auth context"):
// { token, user, role, login, logout }.
//
// Token/user persistence itself lives in api/client.js (getToken/setToken/
// clearToken, getUser/setUser/clearUser) so the localStorage keys stay
// defined in one module. This file only orchestrates that storage plus the
// React state that makes the rest of the app re-render on login/logout.

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
    getToken,
    setToken,
    clearToken,
    getUser,
    setUser,
    clearUser,
    onSessionEnded,
    post,
} from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    // Initialise from localStorage so a page refresh keeps the session
    // (Req 11.2 stores the token/role for "the current session", which must
    // survive a reload since there is no other place a SPA keeps state).
    const [token, setTokenState] = useState(() => getToken());
    const [user, setUserState] = useState(() => getUser());

    const logout = useCallback(() => {
        clearToken();
        clearUser();
        setTokenState(null);
        setUserState(null);
    }, []);

    // React to a 401 detected anywhere in the app (client.js already cleared
    // the token). This is what makes Req 11.4 ("discard the stored token and
    // role, display the Login screen") happen app-wide: every component
    // reading useAuth() re-renders into the logged-out state, not just the
    // request() call site.
    useEffect(() => {
        onSessionEnded(() => {
            clearUser();
            setTokenState(null);
            setUserState(null);
        });
    }, []);

    const login = useCallback(async (email, password) => {
        // Let a rejected login (ApiError) propagate to the caller (LoginScreen)
        // so it can show the message and keep the form filled in (Req 11.16).
        const response = await post('/api/auth/login', { email, password });

        const loggedInUser = {
            id: response.id,
            email: response.email,
            role: response.role,
            assignedLocation: response.assignedLocation,
        };

        setToken(response.token);
        setUser(loggedInUser);
        setTokenState(response.token);
        setUserState(loggedInUser);

        return true; // caller navigates to Inventory on success (Req 11.2)
    }, []);

    const value = {
        token,
        user,
        role: user ? user.role : null,
        login,
        logout,
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    return useContext(AuthContext);
}

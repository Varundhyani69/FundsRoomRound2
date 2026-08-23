import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// vite.config.js -- fails the Web_Client build fast when the required
// build-time base URL is missing (Req 10.11).
//
// Vite does NOT populate process.env with values from .env files while this
// config function runs (that injection only happens later, for
// `import.meta.env` inside application code). To read an env var here we
// have to load it explicitly with the `loadEnv` helper exported by Vite,
// which reads `.env`, `.env.local`, `.env.[mode]`, and `.env.[mode].local`
// from the given directory and also picks up anything already set in
// process.env (so CI environments that export the variable directly still
// work without a `.env` file).
export default defineConfig(({ mode }) => {
    // Third argument '' loads every variable regardless of the `VITE_`
    // prefix filter that `import.meta.env` normally applies -- we only need
    // to read one specific variable here, not expose it to the app.
    const env = loadEnv(mode, process.cwd(), '');

    const apiBaseUrl = env.VITE_API_BASE_URL;
    if (typeof apiBaseUrl !== 'string' || apiBaseUrl.trim() === '') {
        // Non-zero exit, error naming the missing variable (Req 10.11).
        throw new Error(
            'VITE_API_BASE_URL is required to build the Web_Client and must not be empty or whitespace-only. ' +
            'Set it in frontend/.env or in the build environment.'
        );
    }

    return {
        plugins: [react()],
    };
});

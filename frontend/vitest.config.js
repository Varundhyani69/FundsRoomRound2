import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// frontend/vitest.config.js -- the permanent Vitest configuration for the
// five screen tests (task 10.11) and the API client property test
// (task 10.12), replacing the temporary per-task configs used while
// building tasks 10.5-10.9.
//
// This is a standalone config, not merged with vite.config.js: that file
// throws when VITE_API_BASE_URL is missing (Req 10.11), which is a
// build-time concern for the real app and has nothing to do with running
// tests. Keeping the two configs separate means `npm test` never depends on
// a `.env` file being present.
export default defineConfig({
    plugins: [react()],
    test: {
        // jsdom gives the screens a DOM to render into outside a browser.
        environment: 'jsdom',
        // Registers the jest-dom matchers before every test file.
        setupFiles: ['./src/test/setup.js'],
        // globals: true exposes describe/test/expect/vi without an import
        // in every test file, matching the backend's Jest convention
        // (backend/jest.config.js) so contributors moving between the two
        // suites do not have to remember two different styles.
        globals: true,
    },
});

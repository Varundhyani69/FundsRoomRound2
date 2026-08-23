// frontend/src/test/setup.js -- runs once before every test file (wired in
// via vitest.config.js `test.setupFiles`).
//
// @testing-library/jest-dom ships a dedicated './vitest' entry point that
// extends Vitest's `expect` (the plain '@testing-library/jest-dom' entry
// targets Jest's global `expect` instead). Importing it here registers
// matchers like toBeInTheDocument() for every test file, so screen tests
// don't need to import the matchers themselves.
import '@testing-library/jest-dom/vitest';

// React Testing Library v14+ calls cleanup() automatically after each test
// once it detects a test framework's global afterEach hook, which
// `globals: true` in vitest.config.js provides -- no explicit
// afterEach(cleanup) call is needed here.

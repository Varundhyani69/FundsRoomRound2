// frontend/tailwind.config.js -- Tailwind scans these files for class names used at
// build time; nothing outside `content` gets its CSS generated. A small `slate`/`blue`
// based palette is enough for a clean, functional ERP look without a design system.

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
        },
      },
    },
  },
  plugins: [],
};

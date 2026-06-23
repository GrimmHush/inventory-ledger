import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Resolve the `inventory-ledger` library from its TypeScript source rather than
// its built dist. The web client is a workspace consumer of the root package
// (`file:..`); resolving from source removes the build-order dependency on the
// library's `dist` (which a fresh `npm install` copies in empty, before it is
// built) so the standalone demo builds without first running the library build.
const libEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

// The dev server proxies /api to the Express API, so the browser sees same-origin
// requests (no CORS) and `InventoryClient` can use an empty baseUrl. Point this at
// wherever `npm run dev` serves the API.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'inventory-ledger': libEntry,
    },
  },
  server: {
    // Allow importing the library source from the parent workspace dir.
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});

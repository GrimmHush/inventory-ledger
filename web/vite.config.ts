import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the Express API, so the browser sees same-origin
// requests (no CORS) and `InventoryClient` can use an empty baseUrl. Point this at
// wherever `npm run dev` serves the API.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});

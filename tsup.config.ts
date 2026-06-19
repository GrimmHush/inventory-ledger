import { defineConfig } from 'tsup';

// Builds the reusable library surface (domain model, sync core, and SDK).
// The server is an application entry point, run via `npm run dev` / `npm start`.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});

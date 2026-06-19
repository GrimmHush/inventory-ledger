import { defineConfig } from 'vitest/config';

// The library + server suite lives under `test/`. The `web` workspace ships its
// own Vitest config (jsdom + fake-indexeddb), so scope the root run to `test/`
// and let `npm test -w @inventory-ledger/web` cover the client.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});

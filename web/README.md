# @inventory-ledger/web

An offline-first browser client for the inventory API. It queues stock actions in
IndexedDB while offline and flushes them to `POST /api/sync` on reconnect, where the
server reconciles the timeline. See [`PLAN.md`](./PLAN.md) for the full design.

This is an npm workspace of the root `inventory-ledger` package and imports its
public surface (`merge`, `deriveStockByItem`, `InventoryClient`) directly — so the
*same* pure merge that runs on the server also runs in the browser for optimistic
stock.

## Run the demo

From the **repo root** (the workspace root):

```bash
npm install            # installs the web workspace too (one node_modules)
npm run build          # builds the library's dist/ — the web import resolves to it
npm run dev            # terminal 1: start the Express API on :3000 (in-memory store)
npm run dev -w @inventory-ledger/web   # terminal 2: Vite dev server on :5173
```

Open http://localhost:5173. The Vite dev server proxies `/api` to `:3000`, so the
browser makes same-origin requests (no CORS). Set `VITE_API_KEY` if the API isn't
using the default `dev-key`.

> Re-run `npm run build` after changing the library — the web app imports the built
> `dist/`, not the TypeScript source.

## See offline sync work

1. Add an item and an `in` movement; watch stock update.
2. Open DevTools → Network → set **Offline**.
3. Record a few more movements — they queue in the **Outbox** and stock updates
   optimistically (the local fold runs the same `merge` the server will).
4. Set the network back to **Online** (or click **Sync now**). The queue flushes;
   `applied`/`duplicate` clear, and any `rejected`/`superseded` op stays as a
   **conflict** for you to discard or re-record.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev -w @inventory-ledger/web` | Vite dev server |
| `npm run build -w @inventory-ledger/web` | Production build |
| `npm run typecheck -w @inventory-ledger/web` | `tsc --noEmit` |
| `npm test -w @inventory-ledger/web` | Vitest (jsdom + fake-indexeddb) |

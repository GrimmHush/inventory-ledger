# Offline-first web client — design plan

Status: **implemented.** Build steps 1–5 (§13) are done: workspace wiring, the
framework-free engine (`db`/`outbox`/`optimistic`/`sync-controller`), the React UI,
conflict surfacing + crash recovery, and tests — engine unit tests
(`test/outbox.test.ts`), a store-level integration test driving the full offline →
flush → reconcile loop incl. a conflict-kept case (`test/store.test.ts`), and
component tests for the conflict UI (`test/ui.test.tsx`). The end-to-end
offline → flush → reconcile story is also shown as a runnable transcript at the repo
root (`npm run demo`, [`demo/sync-demo.ts`](../demo/sync-demo.ts)) — same pure
`merge`, no browser required; the browser walkthrough below is the visual version
(offline toggled via DevTools). This document remains the spec — see
[`README.md`](./README.md) to run the app. First item on the root roadmap ("A
browser/local client that queues ops in IndexedDB and syncs on reconnect").

## 1. Goal & acceptance

A browser app that demonstrates the sync engine's central thesis outside the test
suite. The acceptance walkthrough:

1. Open the app online; it lists items with derived stock.
2. Open DevTools → go offline.
3. Record ~5 stock movements. They queue locally and the UI updates optimistically.
4. Go back online.
5. The queue flushes to the Express API and reconciles per op: `applied` /
   `duplicate` clear silently; **`rejected` / `superseded` are kept as conflicts
   for the user to resolve** (discard, or edit-and-requeue).

## 2. Decisions (resolved)

- **UI framework: React.** The app's shape — multiple async sources (IndexedDB
  outbox, `online`/`offline` events, flush results) mutating shared state that
  several views render — is exactly what React handles. The sync logic stays
  framework-agnostic (plain TS modules, no React imports); React only renders, and
  subscribes to the outbox via `useSyncExternalStore`.
- **Dependency strategy: npm workspaces.** Root `package.json` gains
  `"workspaces": ["web"]`; `web` depends on `"inventory-ledger": "*"` and imports
  the package's **public exports only** (never deep `src/` paths), preserving the
  layering boundary.
- **Failed-op policy: surface as conflict, keep.** A `rejected`/`superseded` op is
  never silently dropped or blindly retried; it is held for manual resolution.

## 3. What already exists (do not rebuild)

- `POST /api/sync` accepts a `SyncOp[]` batch and returns `{ outcomes }` (per-op).
- SDK: `client.sync(ops)`, `client.iterateItems()`, `client.iterateMovements(id)`.
- The pure `merge(state, ops)` and `deriveStockByItem` — **zero Node deps**
  (verified), importable straight into the browser. The client runs the *same*
  merge to predict outcomes optimistically.
- Idempotency: a replayed movement id returns `duplicate`, so re-flushing a batch
  after an ambiguous network drop is safe (at-least-once delivery).

The package's public index already re-exports everything needed
(`merge`, `emptyState`, `deriveStockByItem`, `stockFromMovements`, `wouldOverdraw`,
the domain/sync types, and `InventoryClient`). **No new library exports required.**

## 4. File layout

```
web/                          # npm workspace; does NOT affect the library's tsup bundle
  package.json                # deps: inventory-ledger, idb, react, react-dom, react-router-dom
                              # devDeps: vite, @vitejs/plugin-react, typescript, vitest, jsdom,
                              #          fake-indexeddb, @testing-library/react,
                              #          @types/react, @types/react-dom
  vite.config.ts              # dev proxy /api -> http://localhost:3000 (see §5)
  tsconfig.json
  index.html
  src/
    api.ts                    # builds InventoryClient (baseUrl '', key from VITE_API_KEY)
    db.ts                     # idb: open(), typed object stores + indexes
    outbox.ts                 # enqueue + state-machine transitions (§6, §7)  [no React]
    optimistic.ts             # fold pending ops over the server mirror via pure merge (§8) [no React]
    sync-controller.ts        # online detection, flush loop, backoff, recovery (§9) [no React]
    store.ts                  # external store: subscribe()/getSnapshot() over outbox + online state
    ui/
      App.tsx                 # app shell + react-router-dom routes
      Sidebar.tsx             # nav between the views
      ViewHeader.tsx          # shared per-view header (online/sync status)
      ItemList.tsx
      MovementForm.tsx
      OutboxPanel.tsx
      ConflictBanner.tsx
      icons.tsx               # inlined Lucide nav icons
      styles.css
      useStore.ts             # useSyncExternalStore hook over store.ts
      views/
        ItemsView.tsx
        ItemLedgerView.tsx
        SyncView.tsx
    main.tsx                  # createRoot(...).render(<App/>) inside the router
```

The sync engine (`outbox`, `optimistic`, `sync-controller`, `store`) is DOM- and
React-free and unit-testable on its own. React components consume `store.ts` via
`useSyncExternalStore`.

## 5. Wiring to the API (two gotchas)

- **CORS:** the Vite dev server (`:5173`) hitting Express (`:3000`) is cross-origin,
  and the API has no CORS middleware. **Use Vite's dev proxy**
  (`server.proxy['/api'] -> http://localhost:3000`) so the browser sees same-origin
  and the server stays untouched. `InventoryClient` `baseUrl` is then `''`.
- **API key:** inject via `VITE_API_KEY` (default `dev-key`). Document that shipping
  a key to the browser is a demo-only shortcut, not a deployment pattern.

## 6. Outbox schema (IndexedDB via `idb`)

```
DB "inventory-outbox" (v1)
  store "ops"      keyPath: op.id
    record: {
      op:         SyncOp,                                   // exact payload sent to /api/sync
      status:     'pending' | 'inflight' | 'conflict',      // 'settled' => deleted, not stored
      enqueuedAt: string,                                   // ISO, for UI ordering
      outcome?:   OpOutcome,                                // set when status === 'conflict' (the reason)
    }
    index "byStatus" on status
  store "meta"     keyPath: key
    record: { key: 'clientSeq', value: number }             // monotonic counter, persisted (§7)
```

`op.id` as the keyPath gives free local dedupe and matches the server's id-keyed
idempotency.

## 7. Op lifecycle state machine

```
                enqueue
                  |
                  v
            +----------+  flush starts (batch)   +-----------+
            | pending  |------------------------>| inflight  |
            +----+-----+                          +-----+-----+
                 ^   ^                                  |
   network error |   | startup recovery                | /api/sync responds, per op:
   (revert batch)|   | (inflight -> pending)           |
                 |   +---------------------------------+
                 |                                      |-- applied | duplicate ---> DELETE (settled)
   user edits &  |                                      |
   re-queues ----+                                      +-- rejected | superseded -> conflict
   (new id)                                                                  (keep + outcome)
                                                            conflict --user discard--> DELETE
```

- `inflight` exists so a crash mid-flush is recoverable: on startup, **reset every
  `inflight` -> `pending`** and re-flush. Safe because the server returns
  `duplicate` for anything that actually committed.
- `conflict` is terminal until the user acts. Resolution = discard (delete) or
  edit-and-requeue (delete old, enqueue a **new** op with a fresh id/clientSeq).
  Never silently retried.

## 8. Enqueue rules — the correctness crux

`merge` orders ops by `createdAt`, then `clientSeq`, then `id`. All three are
assigned **at the moment of the user action**, never at flush time — otherwise
offline ordering collapses.

- `id`: `crypto.randomUUID()`.
- `clientSeq`: read-increment-write the persisted `meta.clientSeq` counter.
  Monotonic per client; the deterministic tie-breaker when two ops share a
  `createdAt`.
- `createdAt`: `new Date().toISOString()` at action time.
- For movements, `op.movement.occurredAt` is **distinct** from `op.createdAt`:
  `occurredAt` places the movement in the ledger and drives the per-prefix overdraw
  check. Default it to now, but let the form **backdate** it — that's the
  offline-recording use case the engine is built for.

## 9. Optimistic stock (the payoff)

Keep an in-memory **server mirror** `LedgerState` (last authoritative read). Derive
the displayed view by folding the outbox over it with the *same pure merge*:

```ts
const pending = ops.filter(o => o.status !== 'conflict').map(o => o.op);
const { state } = merge(serverMirror, pending);          // same code the server runs
const stock = deriveStockByItem(Object.values(state.movements));
```

Because it's the identical merge, the client predicts each pending op's outcome
locally — the UI can pre-flag an op that will likely be `rejected` (a local
overdraw) before it reaches the server. Local prediction and server verdict diverge
only when another client's movements (absent from the mirror) change the picture —
exactly the conflict the demo is meant to show.

## 10. Flush controller

**Triggers:** the `window` `online` event; a manual "Sync now" button; immediately
after enqueue if already online; a jittered backoff timer while online with a
non-empty/failing queue.

**Algorithm:**

1. Bail if offline or a flush is already running (single-flight guard).
2. Load `pending` ops, sort by `(createdAt, clientSeq, id)`; mark them `inflight`.
3. `await client.sync(batch)`.
4. **Network/transport error** (`InventoryApiError` 5xx or a fetch rejection):
   revert `inflight -> pending`, schedule a backoff retry. Do **not** create
   conflicts — the op's fate is unknown.
5. **Success:** match each `outcome` to its op by id ->
   - `applied` / `duplicate` -> delete the record.
   - `rejected` / `superseded` -> set `status: 'conflict'`, store `outcome`.
6. Re-read authoritative state (§11), replace the mirror, recompute the optimistic
   view, notify the store (re-render).

**Crash recovery:** on startup, `inflight -> pending`, then trigger a flush.

## 11. Re-read after flush

`/api/sync` is outcomes-only by design, so rebuild state via the paginated reads:

```ts
const items = []; for await (const it of client.iterateItems()) items.push(it);
// and client.iterateMovements(id) for the focused item's ledger
```

Rebuild the mirror from these. Items carry derived `stock`; the movement log feeds
the optimistic fold.

## 12. Testing

- `outbox.ts`, `optimistic.ts`, `sync-controller.ts` unit-tested against
  `fake-indexeddb` + a mock `fetch` (the `fakeFetch` pattern from the SDK tests
  ports directly). Cover: enqueue assigns monotonic `clientSeq`; applied/duplicate
  prune; rejected/superseded -> conflict; crash recovery re-flushes inflight;
  network error reverts without creating conflicts.
- Optional: a couple of component tests with Testing Library for the conflict UI.
  The core coverage stays DOM-free and does not depend on React.
- The end-to-end offline->online walkthrough (§1) is manual via the DevTools network
  toggle — that's the demo artifact, not a replacement for the unit tests.

## 13. Build order

1. `web/` scaffold (Vite + React + TS), workspace wiring, Vite `/api` proxy, `api.ts`
   -> render a static item list from the live API (proves wiring end-to-end).
2. `db.ts` + `outbox.ts` enqueue + `optimistic.ts` fold + `store.ts` -> movements
   queue and stock updates optimistically while offline.
3. `sync-controller.ts` flush + reconcile + re-read -> going online drains the queue.
4. Conflict surfacing UI (`ConflictBanner`, resolve actions) + crash recovery.
5. Unit tests, then the README demo walkthrough.

## 14. Non-goals (first slice)

- Service Worker / Background Sync API — a foreground `online`-triggered flush demos
  identically and is portable; revisit only for closed-tab sync.
- Multi-tab coordination (BroadcastChannel).
- Auth beyond the demo `VITE_API_KEY`.
- Conflict **auto-merge** — the user resolves manually (per §2).

# inventory-ledger

An offline-first inventory service built around an **append-only movement ledger**. It ships with a typed REST API, a typed client SDK, and a fully tested sync core that reconciles changes made by clients while they were offline.

It is small on purpose. The interesting part is not the feature count — it's the data model and the merge logic, which are designed to make offline-first **safe** rather than merely possible.

```
TypeScript · strict mode · Vitest · ESLint · GitHub Actions CI
```

## Why this design

Most "offline-first" demos store current stock as a number and sync it with last-write-wins. That quietly loses data: if two devices both sell stock while offline, whichever syncs last overwrites the other.

This service avoids that by never storing stock at all. Stock is **derived** from an append-only log of movements (`in`, `out`, `adjust`). That choice has three consequences worth calling out:

- **Movements are conflict-free.** Two clients adding different movements offline simply merge — both survive, because appending to a log has no "winner". Replays are idempotent because every movement is keyed by id.
- **Item metadata still needs a rule.** Names and SKUs are mutable, so concurrent edits resolve **last-write-wins by `updatedAt`**. The merge reports a stale edit as `superseded` rather than silently dropping it.
- **Integrity is enforced at merge time.** The one case naive sync gets wrong: two offline withdrawals that are each valid alone but together overdraw stock. The merge folds in all known movements, detects the overdraw, and **rejects** the second one instead of letting stock go negative.

The merge function returns a per-op outcome — `applied`, `superseded`, `duplicate`, or `rejected` — so a client knows the exact fate of every pending change. That logic lives in [`src/sync/merge.ts`](src/sync/merge.ts) and is the file worth reading first.

## Quickstart

```bash
npm install
npm test          # 21 tests across the ledger, the merge core, and the API
npm run dev       # starts the API on http://localhost:3000
```

Then, with the server running:

```bash
curl -s localhost:3000/api/items -H "x-api-key: dev-key"
```

### Using the SDK

```ts
import { InventoryClient } from 'inventory-ledger';

const client = new InventoryClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'dev-key',
});

await client.upsertItem({
  id: 'bolt', sku: 'blt-1', name: 'Bolt',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

await client.addMovement({
  id: crypto.randomUUID(), itemId: 'bolt', type: 'in',
  quantity: 100, occurredAt: new Date().toISOString(),
});

const { items } = await client.listItems();
console.log(items[0]?.stock); // 100 — derived, never stored
```

## Architecture

The codebase is layered so the interesting logic is pure and the I/O is thin:

| Layer | Path | What it is |
| --- | --- | --- |
| Domain | `src/domain` | Item & movement types, stock derivation, the non-negative invariant. Pure. |
| Sync | `src/sync` | The offline reconciliation merge. Pure, deterministic, the heart of the project. |
| Server | `src/server` | An Express API with API-key auth, and an in-memory store. |
| SDK | `src/sdk` | A typed client whose return types flow from the same domain model. |

The persistence boundary is deliberate: domain and sync logic are pure functions, and the only stateful piece is `LedgerStore` in `src/server/store.ts`. Swapping the in-memory store for Postgres, SQLite, or Mongo touches that one file and nothing else.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the API with watch-reload |
| `npm test` | Run the test suite |
| `npm run typecheck` | `tsc --noEmit` under strict settings |
| `npm run lint` | ESLint (flat config, typescript-eslint) |
| `npm run build` | Bundle the library + type declarations with tsup |

CI runs typecheck, lint, tests, and build on every push and pull request.

## Roadmap

Deliberately out of scope for now, in rough priority order:

- Persistent storage (Postgres or SQLite) behind the existing store boundary
- Request-body validation with zod at the API edge
- A browser/local client that queues ops in IndexedDB and syncs on reconnect
- Users, organizations, and per-org data scoping
- Multiple stock locations / warehouses
- Double-entry accounting on top of the same ledger primitive

## License

MIT

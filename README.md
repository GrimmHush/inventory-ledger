# inventory-ledger

**Stock is never stored — it is *derived* by folding an append-only log of movements. That single decision is what makes offline-first sync _safe_, not merely possible.**

An offline-first inventory service built around an **append-only movement ledger**. It ships with a typed REST API, a typed client SDK, and a fully tested sync core that reconciles changes made by clients while they were offline.

It is small on purpose. The interesting part is not the feature count — it's the data model and the merge logic, which are designed to make offline-first **safe** rather than merely possible.

```
TypeScript · strict mode · Prisma + Postgres · Vitest · ESLint · GitHub Actions CI
```

## Why this design

Most "offline-first" demos store current stock as a number and sync it with last-write-wins. That quietly loses data: if two devices both sell stock while offline, whichever syncs last overwrites the other.

This service avoids that by never storing stock at all. Stock is **derived** from an append-only log of movements (`in`, `out`, `adjust`). That choice has three consequences worth calling out:

- **Movements are conflict-free.** Two clients adding different movements offline simply merge — both survive, because appending to a log has no "winner". Replays are idempotent because every movement is keyed by id.
- **Item metadata still needs a rule.** Names and SKUs are mutable, so concurrent edits resolve **last-write-wins by `updatedAt`**. The merge reports a stale edit as `superseded` rather than silently dropping it.
- **Integrity is enforced at merge time.** The one case naive sync gets wrong: two offline withdrawals that are each valid alone but together overdraw stock. The merge folds in all known movements, detects the overdraw, and **rejects** the second one instead of letting stock go negative.

The merge function returns a per-op outcome — `applied`, `superseded`, `duplicate`, or `rejected` — so a client knows the exact fate of every pending change. That logic lives in [`src/sync/merge.ts`](src/sync/merge.ts) and is the file worth reading first.

## Demo: watch offline → queue → reconcile

`npm run demo` plays the whole thesis out end to end. It starts the real API in
process, drives it through the real SDK over HTTP, and predicts offline stock with
the **same** pure `merge` the server runs — then narrates two devices going offline,
queuing changes, and reconnecting. Nothing is mocked; the values below are the
script's actual output ([`demo/sync-demo.ts`](demo/sync-demo.ts)):

```text
==========================================================================
  1. Online: one source of truth, stock derived from the ledger
==========================================================================
  online    create item bolt (Bolt M6), receive 100 in
  online    server stock = 100
            both devices sync, then lose connectivity ↓

==========================================================================
  2. Offline: each device queues actions; stock folds locally
==========================================================================
  phone     sells 70  → optimistic stock 30 (outbox: 1)
  tablet    renames → "Bolt M6 (steel)", sells 60
  tablet    optimistic stock 40 (outbox: 2)
            neither device can see the other's pending sale — that's the crux

==========================================================================
  3. Phone reconnects: queue flushes, server reconciles
==========================================================================
  phone     also renamed offline → "Bolt M6 (zinc-plated)" (updatedAt 09:25)
            ok phone-sell    APPLIED
            ok phone-rename  APPLIED
  phone     confirmed: stock 30, name "Bolt M6 (zinc-plated)"

==========================================================================
  4. At-least-once delivery: a replayed op is a harmless duplicate
==========================================================================
  phone     re-sends the 70-unit sale after a dropped response
            ~  phone-sell    DUPLICATE

==========================================================================
  5. Tablet reconnects: optimism meets reality
==========================================================================
  tablet    showed stock 40, name "Bolt M6 (steel)" while offline
  tablet    flushes its 2 queued ops…
            !! tablet-rename SUPERSEDED — a newer version of this item already exists
            !! tablet-sell   REJECTED — would drive stock of item bolt negative
  tablet    reality: stock 30, name "Bolt M6 (zinc-plated)"
  tablet    2 op(s) kept as conflicts to resolve (discard or re-record)

==========================================================================
  Recap: every pending change has a known fate
==========================================================================
  applied     phone sale + rename committed
  duplicate   the replayed sale was deduped by id (no double-count)
  superseded  tablet's rename lost LWW to phone's newer edit
  rejected    tablet sale would overdraw once both sales are known —
              the exact case naive last-write-wins corrupts silently
```

The tablet's `40` was never real: once the phone's sale is folded in, a second
withdrawal overdraws and is **rejected** — the exact case naive last-write-wins
corrupts silently. For the same flow in a browser (offline toggled via DevTools),
see [`web/`](web/README.md).

## Start here

If you read one file, read **[`src/sync/merge.ts`](src/sync/merge.ts)** — it's the heart of the project. Everything below this point is reference material for once you've decided to look deeper: how to run it, the full API surface, the layering, and where the model is headed.

## Quickstart

```bash
npm install
npm test          # 59 tests (11 need Postgres and skip without it; see below)
npm run dev       # starts the API on http://localhost:3000 (in-memory store)
```

Then, with the server running:

```bash
curl -s localhost:3000/api/items -H "x-api-key: dev-key"
```

By default the server runs against an **in-memory store** — no database required, which is also how the unit tests and CI's non-database checks run.

### Running against Postgres

Set `DATABASE_URL` and the server switches to the Postgres-backed store automatically:

```bash
docker compose up -d            # start Postgres (see docker-compose.yml)
cp .env.example .env            # DATABASE_URL is already filled in for this DB
npx prisma migrate deploy       # apply migrations from prisma/migrations
npm run dev                     # now backed by Postgres
```

Schema changes are tracked as versioned migrations: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <change>`. The runtime client connects through the `@prisma/adapter-pg` driver adapter; `npm install` runs `prisma generate` automatically.

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

// Outcomes are values, not exceptions: an applied/duplicate/rejected movement
// comes back as a typed result you branch on.
const outcome = await client.addMovement({
  id: crypto.randomUUID(), itemId: 'bolt', type: 'in',
  quantity: 100, occurredAt: new Date().toISOString(),
});
if (outcome.status === 'rejected') throw new Error(outcome.reason);

const { items } = await client.listItems();
console.log(items[0]?.stock); // 100 — derived, never stored

const { movements } = await client.listMovements('bolt'); // the raw ledger

// Or iterate every page transparently — the client follows `nextCursor` for you,
// which is how you rebuild full state after a sync (which returns outcomes only):
for await (const item of client.iterateItems()) console.log(item.id, item.stock);
for await (const m of client.iterateMovements('bolt')) console.log(m.id);
```

A malformed body (400), a bad key (401), or an unknown item (404) throw `InventoryApiError`, whose `body` carries the server's error payload (e.g. the zod validation issues).

## API

Every route under `/api/*` requires the `x-api-key` header. `/health` does not.

| Method & path | Purpose | Notable responses |
| --- | --- | --- |
| `GET /health` | Readiness check — pings the store (a DB round-trip for Postgres) | `200 { ok: true }`, `503` when the store is unreachable |
| `GET /api/items` | List items with **derived** stock (paginated) | `200 { items, nextCursor }` |
| `GET /api/items/:id/movements` | One item's ledger in canonical order (paginated) | `200 { movements, nextCursor }`, `404` if unknown |
| `POST /api/items` | Upsert item metadata (last-write-wins) | `201 { item }`, `409` if superseded, `400` if invalid |
| `POST /api/movements` | Append a movement | `201` outcome, `422` if rejected, `400` if invalid |
| `POST /api/sync` | Reconcile a batch of offline ops | `200 { outcomes }` (per-op), `400` if invalid |

Request bodies are validated at the edge with zod; the business invariants (no overdraw, positive `in`/`out`, non-zero `adjust`) are enforced inside the merge.

The two list endpoints are **cursor-paginated**: pass `?limit=` (default 50, max 200) and `?cursor=`, and follow the `nextCursor` in each response until it's `null`. Cursors are keyset-based (items by id, movements by `occurredAt` then id), so they stay stable as new rows are appended.

## Architecture

The codebase is layered so the interesting logic is pure and the I/O is thin:

| Layer | Path | What it is |
| --- | --- | --- |
| Domain | `src/domain` | Item & movement types, stock derivation, the non-negative invariant. Pure. |
| Sync | `src/sync` | The offline reconciliation merge. Pure, deterministic, the heart of the project. |
| Server | `src/server` | An Express API with API-key auth, zod validation, and a pluggable `LedgerStore`. |
| SDK | `src/sdk` | A typed client whose return types flow from the same domain model. |

The persistence boundary is deliberate: domain and sync logic are pure functions, and the only stateful piece is the `LedgerStore` interface in `src/server/store.ts`. It has two implementations behind the same contract — `InMemoryLedgerStore` (the default) and `PrismaLedgerStore` (Postgres, via Prisma + `@prisma/adapter-pg`) — selected at startup by `DATABASE_URL`. Both reuse the same pure `merge`. The Postgres store does the read, merge, and writes inside one `Serializable` transaction (retried on conflict) so concurrent withdrawals can't both pass the overdraw check; it scopes the read to the items a batch touches; and it keeps a denormalized `stock` checkpoint column — refreshed transactionally, derived from the log — so listing stock doesn't fold the whole history. Adding SQLite or Mongo means a new class implementing the interface and nothing else.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the API with watch-reload |
| `npm test` | Run the test suite |
| `npm run typecheck` | `tsc --noEmit` under strict settings |
| `npm run lint` | ESLint (flat config, typescript-eslint) |
| `npm run build` | Bundle the library + type declarations with tsup |

CI runs typecheck, lint, tests, and build on every push and pull request, with a Postgres service so the database-backed integration tests run there too.

## Scope & non-goals

This project is deliberately small. Its value is **depth on a single idea** — a safe offline-first sync model — rather than breadth of features, and the roadmap below sketches where that model generalizes rather than listing committed work. Building those items out would trade a sharp, complete artifact for a sprawling, incomplete one; keeping the scope tight is the engineering choice.

## Roadmap

Deliberately out of scope for now, in rough priority order:

- A browser/local client that queues ops in IndexedDB and syncs on reconnect
- Users, organizations, and per-org data scoping
- Multiple stock locations / warehouses
- Double-entry accounting on top of the same ledger primitive

## Where this generalizes

A single signed movement is the degenerate case of a **balanced two-entry transfer**: every movement implicitly has a *from* and a *to*, and conserves quantity between them. Under that lens a receipt is `EXTERNAL → warehouse`, a sale is `warehouse → EXTERNAL`, and a stock correction is a transfer to or from an adjustment account. Seen this way, **multi-location stock** and **double-entry accounting** stop being two separate features and collapse into the same primitive — a transfer between two accounts, one of which may be the outside world. This is a sketch of where the model extends, *not* current functionality: today a movement is single-sided (`in` / `out` / `adjust` on one item).

## License

MIT

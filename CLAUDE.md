# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — run the API with watch-reload (tsx) on http://localhost:3000
- `npm start` — run the API once without watch
- `npm test` — run the full Vitest suite once
- `npm run test:watch` — Vitest in watch mode
- `npm run typecheck` — `tsc --noEmit` under strict settings
- `npm run lint` — ESLint (flat config, typescript-eslint)
- `npm run build` — bundle the library + type declarations with tsup

Run a single test file or by name:

```bash
npx vitest run test/sync/merge.test.ts        # one file
npx vitest run -t "rejects an overdraw"        # by test name
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, test, and build on every push and PR. Run all four locally before considering work done.

### Database (optional, for the Postgres-backed store)

- `docker compose up -d` — start the local Postgres (see `docker-compose.yml`)
- `npx prisma migrate dev --name <name>` — create + apply a migration after editing `prisma/schema.prisma` (also regenerates the client)
- `npx prisma migrate deploy` — apply pending migrations without generating one (used in CI and for deploys)
- `npx prisma generate` — regenerate the Prisma client on its own

Schema changes are tracked as versioned migrations in `prisma/migrations` (not `db push`); `migrate deploy` is what provisions the schema in CI and would in production. `npm ci` runs `prisma generate` via a `postinstall` hook, so a fresh checkout always has a working client. The Prisma **CLI** reads its connection URL from `prisma.config.ts` (which loads `.env` via `dotenv`, then `process.env.DATABASE_URL`); the **runtime** client does not — `src/server/prisma.ts` supplies it through the `@prisma/adapter-pg` driver adapter (Prisma 7 requirement). The Postgres integration suite (`test/server/prisma-store.test.ts`) is gated on `DATABASE_URL`: it runs locally when the database is up, in CI against the service container, and is skipped when neither is present.

Server env vars (see `.env.example`): `PORT` (default 3000), `API_KEY` (default `dev-key`), `DATABASE_URL` (when set, the server uses the Postgres-backed store; otherwise it falls back to in-memory).

## Architecture

This is an offline-first inventory service. The defining decision: **stock is never stored** — it is derived by folding an append-only log of movements (`in` / `out` / `adjust`). Understand this before changing anything, because most of the design follows from it.

Layers, in dependency order (lower layers are pure and know nothing of HTTP):

- `src/domain` — `Item`/`Movement` types, stock derivation, the non-negative-stock invariant. Pure functions, no I/O.
- `src/sync` — the offline reconciliation `merge`. Pure, deterministic. The heart of the project.
- `src/server` — Express API with API-key auth + the stateful `LedgerStore` (an interface with in-memory and Postgres implementations).
- `src/sdk` — typed client whose return types flow from the same domain model. It distinguishes **business outcomes from failures**: a superseded upsert (409) or rejected movement (422) come back as typed *values* (callers branch on them), while a malformed body (400, with the zod issues on `InventoryApiError.body`), bad key (401), or server error throw.

### The two reconciliation rules (the whole point)

Read `src/sync/merge.ts` first. Each op in a sync batch resolves to one of **four** outcomes (`applied` / `superseded` / `duplicate` / `rejected`), defined in `src/sync/types.ts`. The two distinct merge strategies:

- **Movements** are an append-only log keyed by id → concurrent additions from different clients merge with no conflict; replaying the same id is an idempotent `duplicate`.
- **Item metadata** (name, SKU) is mutable → concurrent edits resolve **last-write-wins by `updatedAt`**; a stale edit is reported `superseded`, never silently dropped.

Integrity is enforced **at merge time**, not just per-request: a movement valid in isolation but which would overdraw stock once another client's movements are folded in is `rejected`. This is the exact case naive last-write-wins gets wrong. `wouldOverdraw` / `stockFromMovements` in `src/domain/ledger.ts` enforce that stock is never negative *at any point* in the time-ordered ledger, not merely at the end.

Ordering is deliberate and must stay deterministic: ops sort by `createdAt`, then `clientSeq`, then `id` (`merge.ts`); movements sort by `occurredAt`, then `id` (`ledger.ts`). Preserve these tie-breakers.

### Persistence boundary

`LedgerStore` (`src/server/store.ts`) is an **async interface** — the only place that holds a `LedgerState`. **Every** write, including single-item HTTP writes (`upsertItem` / `addMovement`), funnels through `applyOps` → the pure `merge`, so the API and the sync endpoint share one code path and an item upsert is subject to the same last-write-wins check as a synced one (a stale edit returns HTTP 409).

Two implementations satisfy the interface, both reusing the same pure `merge`:

- `InMemoryLedgerStore` (`src/server/store.ts`) — the default, used by tests and when no `DATABASE_URL` is set.
- `PrismaLedgerStore` (`src/server/prisma-store.ts`) — loads the full ledger from Postgres, folds the ops with `merge` in memory, then persists only the accepted ops inside one `$transaction` so a batch lands atomically. Stock is still never stored; it is derived from the movement log exactly as in-memory.

`src/server/main.ts` selects the implementation by `DATABASE_URL`. Adding another backend (SQLite/Mongo) means a new class implementing `LedgerStore` and nothing in the domain or sync layers — keep those pure to preserve that.

### API surface (`src/server/app.ts`)

`/health` sits before the auth middleware (probes need no key) and is a readiness check: it calls `store.ping()` (a `SELECT 1` round-trip for the Postgres store, a no-op for in-memory) and returns 503 `{ ok: false }` when the store is unreachable, 200 `{ ok: true }` otherwise. Everything under `/api/*` requires the `x-api-key` header. `createApp` takes its store and API key as options (no globals/singletons) so tests inject a fresh store. Request bodies are validated at the edge with zod (`src/server/validation.ts`); a malformed body gets a 400 with the zod issues before any handler logic runs. Validation is **structural only** — the business invariants (positive in/out, non-zero adjust, no overdraw) stay in the domain and `merge`, which run on already-parsed data. Keep the validation library confined to `src/server`; the domain and sync layers must not depend on it.

Async route handlers forward failures with `.catch(next)` to a terminal error-handling middleware that replies with a JSON 500 (`{ error: 'internal server error' }`), so the API never falls back to Express's default HTML error page. Any new route must keep that `.catch(next)` so unexpected errors stay JSON.

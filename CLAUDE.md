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

Server env vars (see `.env.example`): `PORT` (default 3000), `API_KEY` (default `dev-key`).

## Architecture

This is an offline-first inventory service. The defining decision: **stock is never stored** — it is derived by folding an append-only log of movements (`in` / `out` / `adjust`). Understand this before changing anything, because most of the design follows from it.

Layers, in dependency order (lower layers are pure and know nothing of HTTP):

- `src/domain` — `Item`/`Movement` types, stock derivation, the non-negative-stock invariant. Pure functions, no I/O.
- `src/sync` — the offline reconciliation `merge`. Pure, deterministic. The heart of the project.
- `src/server` — Express API with API-key auth + the only stateful piece, `LedgerStore`.
- `src/sdk` — typed client whose return types flow from the same domain model.

### The two reconciliation rules (the whole point)

Read `src/sync/merge.ts` first. Each op in a sync batch resolves to one of **four** outcomes (`applied` / `superseded` / `duplicate` / `rejected`), defined in `src/sync/types.ts`. The two distinct merge strategies:

- **Movements** are an append-only log keyed by id → concurrent additions from different clients merge with no conflict; replaying the same id is an idempotent `duplicate`.
- **Item metadata** (name, SKU) is mutable → concurrent edits resolve **last-write-wins by `updatedAt`**; a stale edit is reported `superseded`, never silently dropped.

Integrity is enforced **at merge time**, not just per-request: a movement valid in isolation but which would overdraw stock once another client's movements are folded in is `rejected`. This is the exact case naive last-write-wins gets wrong. `wouldOverdraw` / `stockFromMovements` in `src/domain/ledger.ts` enforce that stock is never negative *at any point* in the time-ordered ledger, not merely at the end.

Ordering is deliberate and must stay deterministic: ops sort by `createdAt`, then `clientSeq`, then `id` (`merge.ts`); movements sort by `occurredAt`, then `id` (`ledger.ts`). Preserve these tie-breakers.

### Persistence boundary

`LedgerStore` (`src/server/store.ts`) is the only mutable state and the only place that holds a `LedgerState`. Single-item HTTP writes funnel through `applyOps` → `merge`, so the API and the sync endpoint share one code path. Swapping the in-memory store for Postgres/SQLite/Mongo should touch this one file and nothing else — keep domain and sync logic pure to preserve that.

### API surface (`src/server/app.ts`)

`/health` sits before the auth middleware (probes need no key). Everything under `/api/*` requires the `x-api-key` header. `createApp` takes its store and API key as options (no globals/singletons) so tests inject a fresh store. Request bodies are currently cast, not validated — zod validation at the edge is a roadmap item, so do not assume inputs are well-formed when adding logic downstream.

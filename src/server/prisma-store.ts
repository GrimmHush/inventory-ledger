import { Prisma, type PrismaClient } from '@prisma/client';
import { deriveStockByItem } from '../domain/ledger';
import type { Item, Movement, MovementType } from '../domain/types';
import { merge } from '../sync/merge';
import type { LedgerState, MergeResult, SyncOp } from '../sync/types';
import {
  addMovementOp,
  upsertItemOp,
  type ItemWithStock,
  type LedgerStore,
} from './store';
import {
  DEFAULT_LIMIT,
  encodeCursor,
  type ItemsPageParams,
  type MovementsPageParams,
  type Page,
} from './pagination';

type ItemRow = {
  id: string;
  sku: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  stock: number;
};

type MovementRow = {
  id: string;
  itemId: string;
  type: string;
  quantity: number;
  reason: string | null;
  occurredAt: Date;
};

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMovement(row: MovementRow): Movement {
  return {
    id: row.id,
    itemId: row.itemId,
    type: row.type as MovementType,
    quantity: row.quantity,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    occurredAt: row.occurredAt.toISOString(),
  };
}

const MAX_TX_ATTEMPTS = 5;

/** The `kind` on a driver-adapter error's `cause`, if it has the expected shape. */
function driverErrorKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('cause' in error)) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null && 'kind' in cause) {
    const kind = (cause as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : undefined;
  }
  return undefined;
}

/**
 * True for a transaction that failed because of a concurrent write, which is
 * safe to retry against fresh state. Prisma maps Postgres serialization failures
 * and deadlocks (SQLSTATE 40001 / 40P01) to the error code `P2034`, while the
 * `pg` driver adapter surfaces 40001 as a `DriverAdapterError` whose cause kind
 * is `TransactionWriteConflict` — depending on the path, either can reach here.
 */
function isRetriableTxError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  ) {
    return true;
  }
  if (driverErrorKind(error) === 'TransactionWriteConflict') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /40001|40P01|could not serialize|deadlock detected/i.test(message);
}

/** Small jittered backoff so retried transactions don't collide in lockstep. */
function backoff(attempt: number): Promise<void> {
  const ms = 5 * attempt + Math.floor(Math.random() * 5);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A Postgres-backed store, drop-in for `InMemoryLedgerStore`. It reuses the same
 * pure `merge`: load the ledger for the items a batch touches, fold the ops, then
 * persist only what merge accepted. The read, the merge, and the writes all run
 * inside one Serializable transaction, so the overdraw decision can never be made
 * on stale data — a concurrent writer forces a serialization failure and a retry.
 *
 * The read is *scoped to the touched items*, not the whole database, so a write
 * is O(those items' history) rather than O(entire ledger) — and the transaction's
 * read set only covers those items, so writes to unrelated items don't conflict.
 * A denormalized `stock` column, refreshed in the same transaction, lets `items()`
 * list stock without folding the log. Stock is still *derived* from movements
 * (the log is the source of truth); the column is a checkpoint of that fold.
 */
export class PrismaLedgerStore implements LedgerStore {
  constructor(private readonly prisma: PrismaClient) {}

  upsertItem(item: Item): Promise<MergeResult> {
    return this.applyOps([upsertItemOp(item)]);
  }

  addMovement(movement: Movement): Promise<MergeResult> {
    return this.applyOps([addMovementOp(movement)]);
  }

  /**
   * Reconcile a batch atomically and *safely under concurrency*. Reading the
   * ledger outside the write transaction — as a naive port would — reintroduces
   * the exact time-of-check/time-of-use race that merge-time integrity exists to
   * prevent: two clients could each read the same stock, each judge their
   * withdrawal valid, and both commit. Here the read happens inside a
   * Serializable transaction, so a concurrent commit aborts this one (P2034) and
   * we retry against fresh state.
   */
  async applyOps(ops: readonly SyncOp[]): Promise<MergeResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.reconcile(tx, ops), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (attempt < MAX_TX_ATTEMPTS && isRetriableTxError(error)) {
          await backoff(attempt);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * The read → merge → write core, run inside a transaction so the read is
   * locked. The returned `MergeResult.state` reflects only the touched items
   * (the read is scoped); the per-op `outcomes` are the authoritative result.
   */
  private async reconcile(
    tx: Prisma.TransactionClient,
    ops: readonly SyncOp[],
  ): Promise<MergeResult> {
    const base = await this.loadScopedState(tx, ops);
    const result = merge(base, ops);

    const applied = new Set(
      result.outcomes
        .filter((outcome) => outcome.status === 'applied')
        .map((outcome) => outcome.id),
    );

    // Item upserts first, so a movement's foreign-key parent exists before it.
    for (const op of ops) {
      if (op.kind !== 'upsertItem' || !applied.has(op.id)) continue;
      await tx.item.upsert({
        where: { id: op.item.id },
        create: {
          id: op.item.id,
          sku: op.item.sku,
          name: op.item.name,
          createdAt: new Date(op.item.createdAt),
          updatedAt: new Date(op.item.updatedAt),
        },
        update: {
          sku: op.item.sku,
          name: op.item.name,
          updatedAt: new Date(op.item.updatedAt),
        },
      });
    }

    const restock = new Set<string>();
    for (const op of ops) {
      if (op.kind !== 'addMovement' || !applied.has(op.id)) continue;
      await tx.movement.create({
        data: {
          id: op.movement.id,
          itemId: op.movement.itemId,
          type: op.movement.type,
          quantity: op.movement.quantity,
          reason: op.movement.reason ?? null,
          occurredAt: new Date(op.movement.occurredAt),
        },
      });
      restock.add(op.movement.itemId);
    }

    // Refresh the stock checkpoint for each item whose log changed, derived from
    // the now-complete per-item movements in the merged state.
    const stockByItem = deriveStockByItem(Object.values(result.state.movements));
    for (const itemId of restock) {
      await tx.item.update({
        where: { id: itemId },
        data: { stock: stockByItem[itemId] ?? 0 },
      });
    }

    return result;
  }

  async items(params?: ItemsPageParams): Promise<Page<ItemWithStock>> {
    const limit = params?.limit ?? DEFAULT_LIMIT;
    const cursor = params?.cursor ?? null;
    // Reads the stock checkpoint directly — no movement fold — and keyset-seeks
    // past the cursor via the primary-key index.
    const rows = await this.prisma.item.findMany({
      where: cursor ? { id: { gt: cursor.id } } : undefined,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const data = rows
      .slice(0, limit)
      .map((row) => ({ ...toItem(row), stock: row.stock }));
    const last = data.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ id: last.id }) : null;
    return { data, nextCursor };
  }

  async itemMovements(
    itemId: string,
    params?: MovementsPageParams,
  ): Promise<Page<Movement> | null> {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!item) return null;

    const limit = params?.limit ?? DEFAULT_LIMIT;
    const cursor = params?.cursor ?? null;
    // Ledger order — occurredAt, then id as the tie-breaker — matches
    // `sortMovements` in the domain, with a composite keyset seek past the cursor.
    const where: Prisma.MovementWhereInput = { itemId };
    if (cursor) {
      const at = new Date(cursor.occurredAt);
      where.OR = [
        { occurredAt: { gt: at } },
        { occurredAt: at, id: { gt: cursor.id } },
      ];
    }
    const rows = await this.prisma.movement.findMany({
      where,
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(toMovement);
    const last = data.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
        : null;
    return { data, nextCursor };
  }

  async ping(): Promise<void> {
    // A trivial round-trip that fails if the connection pool can't reach Postgres.
    await this.prisma.$queryRaw`SELECT 1`;
  }

  /**
   * Read only the slice of the ledger a batch touches: the referenced items, all
   * movements for those items (so overdraw folds the full per-item log), plus any
   * movement whose id is in the batch (so a replay is still detected as a
   * duplicate even if its item isn't otherwise touched). This is what merge needs
   * and nothing more, so the transaction's read set — and conflict footprint —
   * stays tight.
   */
  private async loadScopedState(
    client: Prisma.TransactionClient,
    ops: readonly SyncOp[],
  ): Promise<LedgerState> {
    const itemIds = new Set<string>();
    const movementIds = new Set<string>();
    for (const op of ops) {
      if (op.kind === 'upsertItem') {
        itemIds.add(op.item.id);
      } else {
        itemIds.add(op.movement.itemId);
        movementIds.add(op.movement.id);
      }
    }
    if (itemIds.size === 0) return { items: {}, movements: {} };

    const [itemRows, byItem, byId] = await Promise.all([
      client.item.findMany({ where: { id: { in: [...itemIds] } } }),
      client.movement.findMany({ where: { itemId: { in: [...itemIds] } } }),
      movementIds.size > 0
        ? client.movement.findMany({ where: { id: { in: [...movementIds] } } })
        : Promise.resolve([] as MovementRow[]),
    ]);

    // Keyed by id when built, so the byItem/byId overlap dedupes naturally.
    return buildState(itemRows, [...byItem, ...byId]);
  }
}

function buildState(
  itemRows: ItemRow[],
  movementRows: MovementRow[],
): LedgerState {
  const items: Record<string, Item> = {};
  for (const row of itemRows) {
    const item = toItem(row);
    items[item.id] = item;
  }

  const movements: Record<string, Movement> = {};
  for (const row of movementRows) {
    const movement = toMovement(row);
    movements[movement.id] = movement;
  }

  return { items, movements };
}

import { deriveStockByItem, sortMovements } from '../domain/ledger';
import type { Item, Movement } from '../domain/types';
import { emptyState, merge } from '../sync/merge';
import type { LedgerState, MergeResult, SyncOp } from '../sync/types';
import {
  DEFAULT_LIMIT,
  encodeCursor,
  isAfterMovementCursor,
  type ItemsPageParams,
  type MovementsPageParams,
  type Page,
} from './pagination';

export interface ItemWithStock extends Item {
  stock: number;
}

/**
 * The persistence boundary. Every write funnels through `applyOps` → the pure
 * `merge`, so single-item HTTP writes and the sync endpoint share one code path.
 * The contract is async so a real database (see `PrismaLedgerStore`) can satisfy
 * it without leaking I/O into the domain or sync layers, which stay pure.
 */
export interface LedgerStore {
  upsertItem(item: Item): Promise<MergeResult>;
  addMovement(movement: Movement): Promise<MergeResult>;
  applyOps(ops: readonly SyncOp[]): Promise<MergeResult>;
  /** A page of items (ascending by id) with derived stock. */
  items(params?: ItemsPageParams): Promise<Page<ItemWithStock>>;
  /** A page of one item's movements in ledger order, or `null` if the item is unknown. */
  itemMovements(
    itemId: string,
    params?: MovementsPageParams,
  ): Promise<Page<Movement> | null>;
  snapshot(): Promise<LedgerState>;
  /** Resolves if the backing store is reachable; rejects otherwise. Drives `/health`. */
  ping(): Promise<void>;
}

/** Turns a single item upsert into a one-op sync batch. */
export function upsertItemOp(item: Item): SyncOp {
  return {
    id: item.id,
    kind: 'upsertItem',
    clientSeq: 0,
    createdAt: item.updatedAt,
    item,
  };
}

/** Turns a single movement into a one-op sync batch. */
export function addMovementOp(movement: Movement): SyncOp {
  return {
    id: movement.id,
    kind: 'addMovement',
    clientSeq: 0,
    createdAt: movement.occurredAt,
    movement,
  };
}

/** Derives current stock for every known item, including those with no movements. */
export function itemsWithStock(state: LedgerState): ItemWithStock[] {
  const stock = deriveStockByItem(Object.values(state.movements));
  return Object.values(state.items).map((item) => ({
    ...item,
    stock: stock[item.id] ?? 0,
  }));
}

/**
 * An in-memory store, used by tests and as the default when no database is
 * configured. The domain and sync logic it calls are pure, so a Postgres-backed
 * store (`PrismaLedgerStore`) implements the same interface against the same
 * `merge`. See the persistence boundary in CLAUDE.md.
 */
export class InMemoryLedgerStore implements LedgerStore {
  private state: LedgerState = emptyState();

  upsertItem(item: Item): Promise<MergeResult> {
    return this.applyOps([upsertItemOp(item)]);
  }

  addMovement(movement: Movement): Promise<MergeResult> {
    return this.applyOps([addMovementOp(movement)]);
  }

  applyOps(ops: readonly SyncOp[]): Promise<MergeResult> {
    const result = merge(this.state, ops);
    this.state = result.state;
    return Promise.resolve(result);
  }

  items(params?: ItemsPageParams): Promise<Page<ItemWithStock>> {
    const limit = params?.limit ?? DEFAULT_LIMIT;
    const cursor = params?.cursor ?? null;
    const all = itemsWithStock(this.state).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const after = cursor ? all.filter((i) => i.id > cursor.id) : all;
    const data = after.slice(0, limit);
    const last = data.at(-1);
    const nextCursor =
      after.length > limit && last ? encodeCursor({ id: last.id }) : null;
    return Promise.resolve({ data, nextCursor });
  }

  itemMovements(
    itemId: string,
    params?: MovementsPageParams,
  ): Promise<Page<Movement> | null> {
    if (!this.state.items[itemId]) return Promise.resolve(null);
    const limit = params?.limit ?? DEFAULT_LIMIT;
    const cursor = params?.cursor ?? null;
    const all = sortMovements(
      Object.values(this.state.movements).filter((m) => m.itemId === itemId),
    );
    const after = cursor
      ? all.filter((m) => isAfterMovementCursor(m, cursor))
      : all;
    const data = after.slice(0, limit);
    const last = data.at(-1);
    const nextCursor =
      after.length > limit && last
        ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
        : null;
    return Promise.resolve({ data, nextCursor });
  }

  snapshot(): Promise<LedgerState> {
    return Promise.resolve(this.state);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}

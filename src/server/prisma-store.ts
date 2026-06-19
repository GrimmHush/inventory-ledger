import { Prisma, type PrismaClient } from '@prisma/client';
import type { Item, Movement, MovementType } from '../domain/types';
import { merge } from '../sync/merge';
import type { LedgerState, MergeResult, SyncOp } from '../sync/types';
import {
  addMovementOp,
  itemsWithStock,
  upsertItemOp,
  type ItemWithStock,
  type LedgerStore,
} from './store';

type ItemRow = {
  id: string;
  sku: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
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
 * pure `merge`: load the full ledger, fold the ops in memory, then persist only
 * the ops merge accepted. The read, the merge, and the writes all run inside one
 * Serializable transaction, so the overdraw decision can never be made on stale
 * data — a concurrent writer forces a serialization failure and a retry. Stock
 * is still never stored; it is derived from the movement log as in-memory.
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

  /** The read → merge → write core, run inside a transaction so the read is locked. */
  private async reconcile(
    tx: Prisma.TransactionClient,
    ops: readonly SyncOp[],
  ): Promise<MergeResult> {
    const base = await this.loadState(tx);
    const result = merge(base, ops);

    const applied = new Set(
      result.outcomes
        .filter((outcome) => outcome.status === 'applied')
        .map((outcome) => outcome.id),
    );

    for (const op of ops) {
      if (!applied.has(op.id)) continue;
      if (op.kind === 'upsertItem') {
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
      } else {
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
      }
    }

    return result;
  }

  async items(): Promise<ItemWithStock[]> {
    return itemsWithStock(await this.snapshot());
  }

  async itemMovements(itemId: string): Promise<Movement[] | null> {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!item) return null;

    // Ledger order — occurredAt, then id as the tie-breaker — matches
    // `sortMovements` in the domain, kept deterministic at the query level.
    const rows = await this.prisma.movement.findMany({
      where: { itemId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toMovement);
  }

  async ping(): Promise<void> {
    // A trivial round-trip that fails if the connection pool can't reach Postgres.
    await this.prisma.$queryRaw`SELECT 1`;
  }

  snapshot(): Promise<LedgerState> {
    return this.loadState(this.prisma);
  }

  /**
   * Read the full ledger via the given client. Accepts either the base client
   * (for `snapshot`) or a transaction client (for `reconcile`), so the
   * concurrency-safe read and the plain read share one mapping.
   */
  private async loadState(client: Prisma.TransactionClient): Promise<LedgerState> {
    const [itemRows, movementRows] = await Promise.all([
      client.item.findMany(),
      client.movement.findMany(),
    ]);

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
}

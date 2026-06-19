import type { PrismaClient } from '@prisma/client';
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

/**
 * A Postgres-backed store, drop-in for `InMemoryLedgerStore`. It reuses the same
 * pure `merge`: load the full ledger, fold the ops in memory, then persist only
 * the ops merge accepted — all inside one transaction so a batch lands
 * atomically. Stock is still never stored; it is derived from the movement log
 * exactly as in the in-memory case.
 */
export class PrismaLedgerStore implements LedgerStore {
  constructor(private readonly prisma: PrismaClient) {}

  upsertItem(item: Item): Promise<MergeResult> {
    return this.applyOps([upsertItemOp(item)]);
  }

  addMovement(movement: Movement): Promise<MergeResult> {
    return this.applyOps([addMovementOp(movement)]);
  }

  async applyOps(ops: readonly SyncOp[]): Promise<MergeResult> {
    const base = await this.snapshot();
    const result = merge(base, ops);

    const applied = new Set(
      result.outcomes
        .filter((outcome) => outcome.status === 'applied')
        .map((outcome) => outcome.id),
    );
    const acceptedOps = ops.filter((op) => applied.has(op.id));
    if (acceptedOps.length === 0) {
      return result;
    }

    await this.prisma.$transaction(
      acceptedOps.map((op) =>
        op.kind === 'upsertItem'
          ? this.prisma.item.upsert({
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
            })
          : this.prisma.movement.create({
              data: {
                id: op.movement.id,
                itemId: op.movement.itemId,
                type: op.movement.type,
                quantity: op.movement.quantity,
                reason: op.movement.reason ?? null,
                occurredAt: new Date(op.movement.occurredAt),
              },
            }),
      ),
    );

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

  async snapshot(): Promise<LedgerState> {
    const [itemRows, movementRows] = await Promise.all([
      this.prisma.item.findMany(),
      this.prisma.movement.findMany(),
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

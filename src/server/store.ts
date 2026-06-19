import { deriveStockByItem } from '../domain/ledger';
import type { Item, Movement } from '../domain/types';
import { emptyState, merge } from '../sync/merge';
import type { LedgerState, MergeResult, SyncOp } from '../sync/types';

export interface ItemWithStock extends Item {
  stock: number;
}

/**
 * A simple in-memory store. The domain and sync logic it calls are pure, so
 * swapping this for a real database (Postgres, Mongo, SQLite) touches only this
 * file — that persistence boundary is deliberate. See the roadmap in the README.
 */
export class LedgerStore {
  private state: LedgerState = emptyState();

  upsertItem(item: Item): void {
    this.state.items[item.id] = item;
  }

  addMovement(movement: Movement): MergeResult {
    return this.applyOps([
      {
        id: movement.id,
        kind: 'addMovement',
        clientSeq: 0,
        createdAt: movement.occurredAt,
        movement,
      },
    ]);
  }

  applyOps(ops: readonly SyncOp[]): MergeResult {
    const result = merge(this.state, ops);
    this.state = result.state;
    return result;
  }

  items(): ItemWithStock[] {
    const stock = deriveStockByItem(Object.values(this.state.movements));
    return Object.values(this.state.items).map((item) => ({
      ...item,
      stock: stock[item.id] ?? 0,
    }));
  }

  snapshot(): LedgerState {
    return this.state;
  }
}

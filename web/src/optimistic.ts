import {
  deriveStockByItem,
  merge,
  type Item,
  type LedgerState,
  type Movement,
  type OpOutcome,
  type SyncOp,
} from 'inventory-ledger';

export type ItemView = Item & { stock: number };

export interface OptimisticView {
  /** Items with derived stock, ascending by id. */
  items: ItemView[];
  /** The merged movement log (server-confirmed + optimistically-applied). */
  movements: Movement[];
  /** Predicted outcome status per op id, from folding pending ops locally. */
  predicted: Record<string, OpOutcome['status']>;
}

/**
 * Projects the displayed state by folding the pending ops over the last
 * authoritative read with the *same* pure `merge` the server runs. Because it is
 * the identical fold, the predicted outcomes usually match the server's — they
 * diverge only when another client's movements (absent from the mirror) change the
 * picture, which is exactly the conflict the UI is meant to reveal.
 */
export function project(serverMirror: LedgerState, pendingOps: readonly SyncOp[]): OptimisticView {
  const { state, outcomes } = merge(serverMirror, pendingOps);
  const stock = deriveStockByItem(Object.values(state.movements));

  const items: ItemView[] = Object.values(state.items)
    .map((item) => ({ ...item, stock: stock[item.id] ?? 0 }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const predicted: Record<string, OpOutcome['status']> = {};
  for (const outcome of outcomes) predicted[outcome.id] = outcome.status;

  return { items, movements: Object.values(state.movements), predicted };
}

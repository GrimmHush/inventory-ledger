import { describe, expect, it, vi } from 'vitest';
import {
  deriveStockByItem,
  emptyState,
  merge,
  sortMovements,
  type InventoryClient,
  type ItemWithStock,
  type LedgerState,
  type Movement,
  type SyncOp,
} from 'inventory-ledger';
import { createAppStore, type AppStore } from '../src/store';

/**
 * A faithful in-process stand-in for the API: it reconciles with the *same* pure
 * `merge` the real server runs, so the store integrates against real sync
 * semantics. `inject` simulates a movement another client committed that this
 * client hasn't read yet — the setup for a merge-time conflict.
 */
function fakeServer() {
  let state: LedgerState = emptyState();
  const client = {
    sync(ops: SyncOp[]) {
      const result = merge(state, ops);
      state = result.state;
      return Promise.resolve({ outcomes: result.outcomes });
    },
    async *iterateItems(): AsyncGenerator<ItemWithStock> {
      const stock = deriveStockByItem(Object.values(state.movements));
      const items = Object.values(state.items).sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      for (const item of items) yield { ...item, stock: stock[item.id] ?? 0 };
    },
    async *iterateMovements(itemId: string): AsyncGenerator<Movement> {
      const ms = sortMovements(
        Object.values(state.movements).filter((m) => m.itemId === itemId),
      );
      for (const m of ms) yield m;
    },
  } as unknown as InventoryClient;

  return {
    client,
    inject(movement: Movement) {
      state = { ...state, movements: { ...state.movements, [movement.id]: movement } };
    },
  };
}

let dbCounter = 0;
async function offlineStore(client: InventoryClient): Promise<AppStore> {
  const store = createAppStore(client, { dbName: `store-test-${dbCounter++}` });
  await store.init();
  window.dispatchEvent(new Event('offline'));
  expect(store.getSnapshot().online).toBe(false);
  return store;
}

/** Reconnect and wait for the event-driven flush to drain/settle. */
async function reconnect(store: AppStore): Promise<void> {
  window.dispatchEvent(new Event('online'));
  await vi.waitFor(() => {
    const snap = store.getSnapshot();
    if (snap.syncing) throw new Error('still syncing');
  });
}

describe('app store — offline queue, flush, reconcile', () => {
  it('queues actions offline, then flushes and reconciles on reconnect', async () => {
    const { client } = fakeServer();
    const store = await offlineStore(client);

    await store.addItem({ sku: 'w-1', name: 'Widget' });
    const itemId = store.getSnapshot().view.items[0]!.id;
    await store.addMovement({ itemId, type: 'in', quantity: 10 });
    await store.addMovement({ itemId, type: 'out', quantity: 4 });

    // Offline: nothing reached the server, but the optimistic fold shows 6.
    let snap = store.getSnapshot();
    expect(snap.records).toHaveLength(3);
    expect(snap.records.every((r) => r.status === 'pending')).toBe(true);
    expect(snap.view.items[0]!.stock).toBe(6);

    await reconnect(store);

    // Online: queue drained (all applied), stock now from the server mirror.
    snap = store.getSnapshot();
    expect(snap.online).toBe(true);
    expect(snap.records).toHaveLength(0);
    expect(snap.error).toBeNull();
    expect(snap.view.items[0]!.stock).toBe(6);
  });

  it('keeps an op as a conflict when the server rejects it at merge time', async () => {
    const { client, inject } = fakeServer();
    const store = await offlineStore(client);

    // Establish an item with stock 6 on the server. Explicit, chronological
    // timestamps so the only thing that can overdraw is the hidden withdrawal below.
    await store.addItem({ sku: 'w-1', name: 'Widget' });
    const itemId = store.getSnapshot().view.items[0]!.id;
    await store.addMovement({
      itemId,
      type: 'in',
      quantity: 10,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    await store.addMovement({
      itemId,
      type: 'out',
      quantity: 4,
      occurredAt: '2026-01-02T00:00:00.000Z',
    });
    await reconnect(store);
    expect(store.getSnapshot().view.items[0]!.stock).toBe(6);

    // Another client drains the rest on the server — our mirror doesn't know yet.
    inject({
      id: 'other-out',
      itemId,
      type: 'out',
      quantity: 6,
      occurredAt: '2026-01-03T00:00:00.000Z',
    });

    // Offline again, queue a withdrawal that looks fine locally (mirror says 6).
    window.dispatchEvent(new Event('offline'));
    await store.addMovement({
      itemId,
      type: 'out',
      quantity: 3,
      occurredAt: '2026-01-04T00:00:00.000Z',
    });
    let snap = store.getSnapshot();
    expect(snap.records).toHaveLength(1);
    expect(snap.view.predicted[snap.records[0]!.op.id]).toBe('applied'); // optimistic
    expect(snap.view.items[0]!.stock).toBe(3);

    await reconnect(store);

    // The server folds in the other client's out (stock 0) and rejects ours; it's
    // kept as a conflict, not dropped, and the mirror now reflects the true 0.
    snap = store.getSnapshot();
    expect(snap.records).toHaveLength(1);
    expect(snap.records[0]!.status).toBe('conflict');
    expect(snap.records[0]!.outcome).toMatchObject({ status: 'rejected' });
    expect(snap.view.items[0]!.stock).toBe(0);

    // Resolving by discarding clears the conflict.
    await store.discard(snap.records[0]!.op.id);
    expect(store.getSnapshot().records).toHaveLength(0);
  });
});

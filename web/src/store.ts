import {
  emptyState,
  type InventoryClient,
  type Item,
  type LedgerState,
  type Movement,
} from 'inventory-ledger';
import { client as defaultClient } from './api';
import { openOutboxDb, type OutboxDb, type OutboxRecord } from './db';
import {
  allRecords,
  discardConflict,
  enqueueMovement,
  enqueueUpsertItem,
  recoverInflight,
} from './outbox';
import { project, type OptimisticView } from './optimistic';
import { flushOnce } from './sync-controller';

/** The immutable snapshot React reads via `useSyncExternalStore`. */
export interface AppSnapshot {
  ready: boolean;
  online: boolean;
  syncing: boolean;
  records: OutboxRecord[];
  view: OptimisticView;
  error: string | null;
}

export interface NewMovement {
  itemId: string;
  type: Movement['type'];
  quantity: number;
  reason?: string;
  /** Defaults to now; may be backdated to record an action that already happened. */
  occurredAt?: string;
}

export interface AppStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AppSnapshot;
  init(): Promise<void>;
  addItem(input: { sku: string; name: string }): Promise<void>;
  addMovement(input: NewMovement): Promise<void>;
  flush(): Promise<void>;
  discard(opId: string): Promise<void>;
}

/** Rebuild the authoritative mirror by paging every item and its ledger. */
async function readMirror(client: InventoryClient): Promise<LedgerState> {
  const items: Record<string, Item> = {};
  const movements: Record<string, Movement> = {};
  for await (const it of client.iterateItems()) {
    items[it.id] = {
      id: it.id,
      sku: it.sku,
      name: it.name,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
    };
    for await (const movement of client.iterateMovements(it.id)) {
      movements[movement.id] = movement;
    }
  }
  return { items, movements };
}

/**
 * The single coordinator the UI talks to. It owns the outbox (idb), the server
 * mirror, online detection, and the single-flight flush loop, and exposes an
 * immutable snapshot to React. All sync *logic* lives in the framework-free
 * modules it calls; this layer is just orchestration + the external-store contract.
 *
 * `client` and `dbName` are injectable so tests can drive it with a mock client and
 * an isolated fake-indexeddb database.
 */
export function createAppStore(
  client: InventoryClient = defaultClient,
  options: { dbName?: string } = {},
): AppStore {
  let db: OutboxDb | null = null;
  let mirror: LedgerState = emptyState();
  const listeners = new Set<() => void>();

  let snapshot: AppSnapshot = {
    ready: false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing: false,
    records: [],
    view: { items: [], predicted: {} },
    error: null,
  };

  function set(next: Partial<AppSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }

  /** Recompute the optimistic view from the mirror + the active (non-conflict) ops. */
  async function refreshLocal(): Promise<void> {
    if (!db) return;
    const records = await allRecords(db);
    const activeOps = records.filter((r) => r.status !== 'conflict').map((r) => r.op);
    set({ records, view: project(mirror, activeOps) });
  }

  async function doFlush(): Promise<void> {
    if (!db || !snapshot.online || snapshot.syncing) return;
    set({ syncing: true, error: null });
    try {
      const { flushed } = await flushOnce(db, client);
      if (flushed > 0) mirror = await readMirror(client);
      await refreshLocal();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ syncing: false });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return snapshot;
    },

    async init() {
      db = await openOutboxDb(options.dbName);
      await recoverInflight(db);

      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
          set({ online: true });
          void doFlush();
        });
        window.addEventListener('offline', () => set({ online: false }));
      }

      try {
        mirror = await readMirror(client);
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
      set({ ready: true });
      await refreshLocal();
      void doFlush();
    },

    async addItem(input) {
      if (!db) return;
      const now = new Date().toISOString();
      await enqueueUpsertItem(db, {
        id: crypto.randomUUID(),
        sku: input.sku,
        name: input.name,
        createdAt: now,
        updatedAt: now,
      });
      await refreshLocal();
      void doFlush();
    },

    async addMovement(input) {
      if (!db) return;
      await enqueueMovement(db, {
        id: crypto.randomUUID(),
        itemId: input.itemId,
        type: input.type,
        quantity: input.quantity,
        ...(input.reason ? { reason: input.reason } : {}),
        occurredAt: input.occurredAt ?? new Date().toISOString(),
      });
      await refreshLocal();
      void doFlush();
    },

    async flush() {
      await doFlush();
    },

    async discard(opId) {
      if (!db) return;
      await discardConflict(db, opId);
      await refreshLocal();
    },
  };
}

/** The app-wide singleton used by the React tree. Tests build their own. */
export const store = createAppStore();

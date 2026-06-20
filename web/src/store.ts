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
  /** Remove window listeners and cancel any pending retry. Idempotent. */
  dispose(): void;
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
 * `client`, `dbName`, and the retry timings are injectable so tests can drive it
 * with a mock client, an isolated fake-indexeddb database, and fast backoff.
 */
export function createAppStore(
  client: InventoryClient = defaultClient,
  options: { dbName?: string; retryBaseMs?: number; retryMaxMs?: number } = {},
): AppStore {
  const retryBaseMs = options.retryBaseMs ?? 1000;
  const retryMaxMs = options.retryMaxMs ?? 30000;

  let db: OutboxDb | null = null;
  let mirror: LedgerState = emptyState();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let onlineHandler: (() => void) | null = null;
  let offlineHandler: (() => void) | null = null;
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

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /**
   * Schedule a self-healing retry after a transport failure: exponential backoff
   * (base doubled per attempt, capped) plus jitter so reconnecting clients don't
   * retry in lockstep. A success resets the attempt counter. Business outcomes
   * (rejected/superseded) don't reach here — `flushOnce` only throws on transport
   * failures — so a conflict never triggers an endless retry.
   */
  function scheduleRetry(): void {
    if (retryTimer !== null) return;
    retryAttempt += 1;
    const backoff = Math.min(retryBaseMs * 2 ** (retryAttempt - 1), retryMaxMs);
    const delay = backoff + Math.floor(Math.random() * retryBaseMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void doFlush();
    }, delay);
  }

  async function doFlush(): Promise<void> {
    if (!db || !snapshot.online || snapshot.syncing) return;
    set({ syncing: true, error: null });
    try {
      const { flushed } = await flushOnce(db, client);
      if (flushed > 0) mirror = await readMirror(client);
      retryAttempt = 0;
      clearRetry();
      await refreshLocal();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      scheduleRetry();
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
        onlineHandler = () => {
          set({ online: true });
          retryAttempt = 0;
          clearRetry();
          void doFlush();
        };
        offlineHandler = () => {
          set({ online: false });
          clearRetry(); // no point retrying while offline; the online event re-flushes
        };
        window.addEventListener('online', onlineHandler);
        window.addEventListener('offline', offlineHandler);
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

    dispose() {
      clearRetry();
      if (typeof window !== 'undefined') {
        if (onlineHandler) window.removeEventListener('online', onlineHandler);
        if (offlineHandler) window.removeEventListener('offline', offlineHandler);
      }
      onlineHandler = null;
      offlineHandler = null;
    },
  };
}

/** The app-wide singleton used by the React tree. Tests build their own. */
export const store = createAppStore();

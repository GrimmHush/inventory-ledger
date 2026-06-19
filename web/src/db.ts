import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OpOutcome, SyncOp } from 'inventory-ledger';

// 'settled' is never stored — applied/duplicate ops are deleted outright. The
// three persisted states are the nodes of the lifecycle machine (see PLAN.md §7).
export type OutboxStatus = 'pending' | 'inflight' | 'conflict';

export interface OutboxRecord {
  /** The exact op posted to /api/sync; `op.id` is this record's key. */
  op: SyncOp;
  status: OutboxStatus;
  /** ISO timestamp, for stable display ordering in the outbox panel. */
  enqueuedAt: string;
  /** Set only when `status === 'conflict'`: the rejecting/superseding outcome. */
  outcome?: OpOutcome;
}

interface OutboxDBSchema extends DBSchema {
  ops: {
    key: string;
    value: OutboxRecord;
    indexes: { byStatus: OutboxStatus };
  };
  meta: {
    key: string;
    value: { key: string; value: number };
  };
}

export type OutboxDb = IDBPDatabase<OutboxDBSchema>;

/**
 * Opens (and migrates) the outbox database. `op.id` is the keyPath for `ops`, so
 * the store dedupes locally on the same id the server uses for idempotency.
 */
export function openOutboxDb(name = 'inventory-outbox'): Promise<OutboxDb> {
  return openDB<OutboxDBSchema>(name, 1, {
    upgrade(db) {
      const ops = db.createObjectStore('ops', { keyPath: 'op.id' });
      ops.createIndex('byStatus', 'status');
      db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
}

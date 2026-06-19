import type { InventoryClient } from 'inventory-ledger';
import type { OutboxDb } from './db';
import { applyOutcomes, markInflight, pendingRecords, revertInflight } from './outbox';

export interface FlushResult {
  /** Number of ops reconciled (0 when the queue was empty). */
  flushed: number;
}

/**
 * One flush pass: take the pending ops, mark them inflight, POST the batch, and
 * reconcile the per-op outcomes. On a transport failure the batch is reverted to
 * pending (its fate is unknown, so retry is correct) and the error re-thrown for
 * the caller to surface. Idempotency on the server makes the retry safe.
 *
 * Framework-free and single-batch: the caller (the store) owns the single-flight
 * guard, the online check, backoff, and re-reading authoritative state afterward.
 */
export async function flushOnce(db: OutboxDb, client: InventoryClient): Promise<FlushResult> {
  const pending = await pendingRecords(db);
  if (pending.length === 0) return { flushed: 0 };

  const ids = pending.map((record) => record.op.id);
  await markInflight(db, ids);
  try {
    const { outcomes } = await client.sync(pending.map((record) => record.op));
    await applyOutcomes(db, outcomes);
    return { flushed: outcomes.length };
  } catch (error) {
    await revertInflight(db, ids);
    throw error;
  }
}

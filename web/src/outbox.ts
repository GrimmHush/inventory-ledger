import type { Item, Movement, OpOutcome, SyncOp } from 'inventory-ledger';
import type { OutboxDb, OutboxRecord } from './db';

// The outbox is the local op queue and the home of the lifecycle state machine
// (PLAN.md §6–§7). Every function here is framework-free and operates on the idb
// handle, so it is unit-testable against fake-indexeddb with no DOM or React.

/**
 * Monotonic per-client counter, persisted in `meta`. Assigned at enqueue time so
 * it survives reloads — it is the deterministic tie-breaker `merge` uses when two
 * ops share a `createdAt`, so it must never reset or be assigned at flush time.
 */
async function nextClientSeq(db: OutboxDb): Promise<number> {
  const tx = db.transaction('meta', 'readwrite');
  const current = await tx.store.get('clientSeq');
  const next = (current?.value ?? 0) + 1;
  await tx.store.put({ key: 'clientSeq', value: next });
  await tx.done;
  return next;
}

async function putPending(db: OutboxDb, op: SyncOp): Promise<OutboxRecord> {
  const record: OutboxRecord = {
    op,
    status: 'pending',
    enqueuedAt: new Date().toISOString(),
  };
  await db.put('ops', record);
  return record;
}

/** Queue an item upsert. `createdAt` is stamped now — the moment of the action. */
export async function enqueueUpsertItem(db: OutboxDb, item: Item): Promise<OutboxRecord> {
  const clientSeq = await nextClientSeq(db);
  return putPending(db, {
    id: crypto.randomUUID(),
    kind: 'upsertItem',
    clientSeq,
    createdAt: new Date().toISOString(),
    item,
  });
}

/**
 * Queue a movement. The op's `createdAt` (its place in the sync order) is stamped
 * now; the movement's own `occurredAt` (its place in the ledger) is whatever the
 * caller set, which may be backdated — that's the offline-recording case.
 */
export async function enqueueMovement(db: OutboxDb, movement: Movement): Promise<OutboxRecord> {
  const clientSeq = await nextClientSeq(db);
  return putPending(db, {
    id: crypto.randomUUID(),
    kind: 'addMovement',
    clientSeq,
    createdAt: new Date().toISOString(),
    movement,
  });
}

/** Deterministic send order, mirroring `merge`'s sort: createdAt, clientSeq, id. */
function compareOps(a: SyncOp, b: SyncOp): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.clientSeq !== b.clientSeq) return a.clientSeq - b.clientSeq;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function allRecords(db: OutboxDb): Promise<OutboxRecord[]> {
  return db.getAll('ops');
}

/** Pending records (not yet sent), in the order they should be flushed. */
export async function pendingRecords(db: OutboxDb): Promise<OutboxRecord[]> {
  const records = await db.getAllFromIndex('ops', 'byStatus', 'pending');
  return records.sort((a, b) => compareOps(a.op, b.op));
}

/** Move the given pending ops to `inflight` at the start of a flush. */
export async function markInflight(db: OutboxDb, opIds: string[]): Promise<void> {
  const tx = db.transaction('ops', 'readwrite');
  for (const id of opIds) {
    const record = await tx.store.get(id);
    if (record?.status === 'pending') {
      await tx.store.put({ ...record, status: 'inflight' });
    }
  }
  await tx.done;
}

/** Revert inflight ops to pending after a transport failure (fate unknown). */
export async function revertInflight(db: OutboxDb, opIds: string[]): Promise<void> {
  const tx = db.transaction('ops', 'readwrite');
  for (const id of opIds) {
    const record = await tx.store.get(id);
    if (record?.status === 'inflight') {
      await tx.store.put({ ...record, status: 'pending' });
    }
  }
  await tx.done;
}

/**
 * Reconcile a flush's outcomes: applied/duplicate are pruned (the op landed, or
 * was already there — idempotent), while rejected/superseded become conflicts the
 * user resolves. Matches each outcome to its op by id.
 */
export async function applyOutcomes(db: OutboxDb, outcomes: readonly OpOutcome[]): Promise<void> {
  const tx = db.transaction('ops', 'readwrite');
  for (const outcome of outcomes) {
    const record = await tx.store.get(outcome.id);
    if (!record) continue;
    if (outcome.status === 'applied' || outcome.status === 'duplicate') {
      await tx.store.delete(outcome.id);
    } else {
      await tx.store.put({ ...record, status: 'conflict', outcome });
    }
  }
  await tx.done;
}

/**
 * Crash recovery: on startup, anything left `inflight` (a flush that never got its
 * response) goes back to `pending` for re-flush. Safe because a committed op comes
 * back as `duplicate` the second time.
 */
export async function recoverInflight(db: OutboxDb): Promise<void> {
  const stuck = await db.getAllFromIndex('ops', 'byStatus', 'inflight');
  await revertInflight(db, stuck.map((record) => record.op.id));
}

/** Resolve a conflict by discarding it. (Edit-and-requeue is a new enqueue.) */
export function discardConflict(db: OutboxDb, opId: string): Promise<void> {
  return db.delete('ops', opId);
}

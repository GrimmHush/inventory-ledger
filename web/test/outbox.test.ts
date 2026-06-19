import { describe, expect, it } from 'vitest';
import type { InventoryClient, Movement, OpOutcome, SyncOp } from 'inventory-ledger';
import { openOutboxDb, type OutboxDb } from '../src/db';
import {
  allRecords,
  enqueueMovement,
  markInflight,
  pendingRecords,
  recoverInflight,
} from '../src/outbox';
import { flushOnce } from '../src/sync-controller';

let counter = 0;
function freshDb(): Promise<OutboxDb> {
  return openOutboxDb(`outbox-test-${counter++}`);
}

function movement(partial: Partial<Movement> & Pick<Movement, 'id' | 'type'>): Movement {
  return {
    itemId: 'widget',
    quantity: 1,
    occurredAt: '2026-01-02T00:00:00.000Z',
    ...partial,
  };
}

/** A client whose `sync` returns a fixed verdict per op id; records the batch. */
function fakeClient(
  verdict: (op: SyncOp) => OpOutcome,
  onSync?: (ops: SyncOp[]) => void,
): InventoryClient {
  return {
    sync(ops: SyncOp[]) {
      onSync?.(ops);
      return Promise.resolve({ outcomes: ops.map(verdict) });
    },
  } as unknown as InventoryClient;
}

describe('outbox + flush', () => {
  it('assigns a monotonic clientSeq at enqueue time', async () => {
    const db = await freshDb();
    await enqueueMovement(db, movement({ id: 'm1', type: 'in' }));
    await enqueueMovement(db, movement({ id: 'm2', type: 'in' }));

    const seqs = (await pendingRecords(db)).map((r) => r.op.clientSeq);
    expect(seqs).toEqual([1, 2]);
  });

  it('prunes applied/duplicate ops and keeps rejected ones as conflicts', async () => {
    const db = await freshDb();
    await enqueueMovement(db, movement({ id: 'ok', type: 'in', quantity: 5 }));
    await enqueueMovement(db, movement({ id: 'bad', type: 'out', quantity: 99 }));

    const client = fakeClient((op) =>
      op.kind === 'addMovement' && op.movement.id === 'bad'
        ? { id: op.id, status: 'rejected', reason: 'would drive stock negative' }
        : { id: op.id, status: 'applied' },
    );

    const { flushed } = await flushOnce(db, client);
    expect(flushed).toBe(2);

    const records = await allRecords(db);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('conflict');
    expect(records[0]?.op.id).toBeTruthy();
    expect(records[0]?.outcome).toMatchObject({ status: 'rejected' });
  });

  it('reverts the batch to pending and rethrows on a transport failure', async () => {
    const db = await freshDb();
    await enqueueMovement(db, movement({ id: 'm1', type: 'in' }));

    const failing = {
      sync: () => Promise.reject(new Error('network down')),
    } as unknown as InventoryClient;

    await expect(flushOnce(db, failing)).rejects.toThrow('network down');

    const records = await allRecords(db);
    expect(records.every((r) => r.status === 'pending')).toBe(true);
  });

  it('recovers inflight ops back to pending on startup (re-flush is safe)', async () => {
    const db = await freshDb();
    const rec = await enqueueMovement(db, movement({ id: 'm1', type: 'in' }));
    await markInflight(db, [rec.op.id]);

    // Simulate a crash mid-flush: the op is stuck inflight.
    expect((await allRecords(db))[0]?.status).toBe('inflight');

    await recoverInflight(db);
    expect((await pendingRecords(db)).map((r) => r.op.id)).toEqual([rec.op.id]);
  });

  it('sends nothing and reports zero when the queue is empty', async () => {
    const db = await freshDb();
    let called = false;
    const client = fakeClient(
      (op) => ({ id: op.id, status: 'applied' }),
      () => {
        called = true;
      },
    );

    const { flushed } = await flushOnce(db, client);
    expect(flushed).toBe(0);
    expect(called).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { emptyState, merge } from '../../src/sync/merge';
import type { LedgerState, OpOutcome, SyncOp } from '../../src/sync/types';
import type { Item, Movement } from '../../src/domain/types';

function item(partial: Partial<Item> & Pick<Item, 'id'>): Item {
  return {
    sku: partial.id,
    name: partial.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function upsert(opId: string, it: Item, at = it.updatedAt, seq = 0): SyncOp {
  return { id: opId, kind: 'upsertItem', clientSeq: seq, createdAt: at, item: it };
}

function addMove(opId: string, m: Movement, seq = 0): SyncOp {
  return { id: opId, kind: 'addMovement', clientSeq: seq, createdAt: m.occurredAt, movement: m };
}

function move(partial: Partial<Movement> & Pick<Movement, 'id' | 'type'>): Movement {
  return {
    itemId: 'widget',
    quantity: 1,
    occurredAt: '2026-01-02T00:00:00.000Z',
    ...partial,
  };
}

function stateWithWidget(stock: number): LedgerState {
  const { state } = merge(emptyState(), [
    upsert('op-item', item({ id: 'widget' })),
    addMove('op-seed', move({ id: 'seed', type: 'in', quantity: stock, occurredAt: '2026-01-01T12:00:00.000Z' })),
  ]);
  return state;
}

function outcomeFor(outcomes: OpOutcome[], id: string): OpOutcome {
  const found = outcomes.find((o) => o.id === id);
  if (!found) throw new Error(`no outcome for ${id}`);
  return found;
}

describe('merge — items', () => {
  it('applies a new item', () => {
    const { state, outcomes } = merge(emptyState(), [upsert('op1', item({ id: 'widget' }))]);
    expect(outcomeFor(outcomes, 'op1').status).toBe('applied');
    expect(state.items.widget?.id).toBe('widget');
  });

  it('resolves concurrent edits last-write-wins by updatedAt', () => {
    const base = merge(emptyState(), [upsert('op1', item({ id: 'widget', name: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' }))]).state;
    const { state, outcomes } = merge(base, [
      upsert('op-new', item({ id: 'widget', name: 'New', updatedAt: '2026-03-01T00:00:00.000Z' })),
    ]);
    expect(outcomeFor(outcomes, 'op-new').status).toBe('applied');
    expect(state.items.widget?.name).toBe('New');
  });

  it('marks a stale edit as superseded and keeps the newer value', () => {
    const base = merge(emptyState(), [upsert('op1', item({ id: 'widget', name: 'New', updatedAt: '2026-03-01T00:00:00.000Z' }))]).state;
    const { state, outcomes } = merge(base, [
      upsert('op-old', item({ id: 'widget', name: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' })),
    ]);
    expect(outcomeFor(outcomes, 'op-old').status).toBe('superseded');
    expect(state.items.widget?.name).toBe('New');
  });
});

describe('merge — movements (append-only)', () => {
  it('merges concurrent movements from two clients with no conflict', () => {
    const base = stateWithWidget(10);
    const { state, outcomes } = merge(base, [
      addMove('clientA', move({ id: 'a', type: 'out', quantity: 3, occurredAt: '2026-01-03T00:00:00.000Z' })),
      addMove('clientB', move({ id: 'b', type: 'out', quantity: 2, occurredAt: '2026-01-03T06:00:00.000Z' })),
    ]);
    expect(outcomeFor(outcomes, 'clientA').status).toBe('applied');
    expect(outcomeFor(outcomes, 'clientB').status).toBe('applied');
    // 10 in - 3 - 2 = 5; both offline writes survive.
    expect(Object.keys(state.movements)).toContain('a');
    expect(Object.keys(state.movements)).toContain('b');
  });

  it('treats a replayed movement id as an idempotent duplicate', () => {
    const base = stateWithWidget(5);
    const op = addMove('op-x', move({ id: 'm1', type: 'out', quantity: 1, occurredAt: '2026-01-03T00:00:00.000Z' }));
    const once = merge(base, [op]);
    const twice = merge(once.state, [op]);
    expect(outcomeFor(twice.outcomes, 'op-x').status).toBe('duplicate');
    expect(Object.keys(twice.state.movements).filter((k) => k === 'm1')).toHaveLength(1);
  });

  it('rejects a movement against an unknown item', () => {
    const { outcomes } = merge(emptyState(), [
      addMove('op-x', move({ id: 'm1', itemId: 'ghost', type: 'in', quantity: 1 })),
    ]);
    expect(outcomeFor(outcomes, 'op-x').status).toBe('rejected');
  });

  it('rejects an invalid movement', () => {
    const base = stateWithWidget(5);
    const { outcomes } = merge(base, [
      addMove('op-x', move({ id: 'm1', type: 'out', quantity: -4, occurredAt: '2026-01-03T00:00:00.000Z' })),
    ]);
    expect(outcomeFor(outcomes, 'op-x').status).toBe('rejected');
  });
});

describe('merge — the integrity case naive sync gets wrong', () => {
  it('rejects the second of two offline withdrawals that together overdraw', () => {
    // Item has stock 8. Two clients, each offline, each withdraw 5 — fine in
    // isolation, but together they overdraw. The merge must accept one and
    // reject the other rather than silently letting stock go negative.
    const base = stateWithWidget(8);
    const { state, outcomes } = merge(base, [
      addMove('clientA', move({ id: 'a', type: 'out', quantity: 5, occurredAt: '2026-01-03T00:00:00.000Z' })),
      addMove('clientB', move({ id: 'b', type: 'out', quantity: 5, occurredAt: '2026-01-03T01:00:00.000Z' })),
    ]);
    expect(outcomeFor(outcomes, 'clientA').status).toBe('applied');
    expect(outcomeFor(outcomes, 'clientB').status).toBe('rejected');
    expect(state.movements.a).toBeDefined();
    expect(state.movements.b).toBeUndefined();
  });
});

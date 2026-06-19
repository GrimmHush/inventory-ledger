import { describe, expect, it } from 'vitest';
import {
  InvalidMovementError,
  OverdrawError,
  deriveStockByItem,
  movementEffect,
  stockFromMovements,
  validateMovement,
  wouldOverdraw,
} from '../../src/domain/ledger';
import type { Movement } from '../../src/domain/types';

function move(partial: Partial<Movement> & Pick<Movement, 'id' | 'type'>): Movement {
  return {
    itemId: 'item-1',
    quantity: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('movementEffect', () => {
  it('signs the effect by movement type', () => {
    expect(movementEffect(move({ id: 'm', type: 'in', quantity: 5 }))).toBe(5);
    expect(movementEffect(move({ id: 'm', type: 'out', quantity: 5 }))).toBe(-5);
    expect(movementEffect(move({ id: 'm', type: 'adjust', quantity: -3 }))).toBe(-3);
  });
});

describe('validateMovement', () => {
  it('rejects non-positive in/out quantities', () => {
    expect(() => validateMovement(move({ id: 'm', type: 'in', quantity: 0 }))).toThrow(
      InvalidMovementError,
    );
    expect(() => validateMovement(move({ id: 'm', type: 'out', quantity: -1 }))).toThrow(
      InvalidMovementError,
    );
  });

  it('rejects a zero adjustment but allows a negative one', () => {
    expect(() => validateMovement(move({ id: 'm', type: 'adjust', quantity: 0 }))).toThrow(
      InvalidMovementError,
    );
    expect(() => validateMovement(move({ id: 'm', type: 'adjust', quantity: -2 }))).not.toThrow();
  });
});

describe('stockFromMovements', () => {
  it('derives stock by folding effects in occurrence order', () => {
    const stock = stockFromMovements([
      move({ id: 'a', type: 'in', quantity: 10, occurredAt: '2026-01-01T00:00:00.000Z' }),
      move({ id: 'b', type: 'out', quantity: 4, occurredAt: '2026-01-02T00:00:00.000Z' }),
      move({ id: 'c', type: 'adjust', quantity: -1, occurredAt: '2026-01-03T00:00:00.000Z' }),
    ]);
    expect(stock).toBe(5);
  });

  it('is order-independent in input but order-correct in evaluation', () => {
    // Same movements, shuffled — the function sorts by occurredAt internally.
    const stock = stockFromMovements([
      move({ id: 'b', type: 'out', quantity: 4, occurredAt: '2026-01-02T00:00:00.000Z' }),
      move({ id: 'a', type: 'in', quantity: 10, occurredAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(stock).toBe(6);
  });

  it('throws if stock ever goes negative', () => {
    expect(() =>
      stockFromMovements([
        move({ id: 'a', type: 'in', quantity: 3, occurredAt: '2026-01-01T00:00:00.000Z' }),
        move({ id: 'b', type: 'out', quantity: 5, occurredAt: '2026-01-02T00:00:00.000Z' }),
      ]),
    ).toThrow(OverdrawError);
  });
});

describe('wouldOverdraw', () => {
  it('detects an overdraw without throwing', () => {
    const existing = [move({ id: 'a', type: 'in', quantity: 2 })];
    const next = move({ id: 'b', type: 'out', quantity: 5, occurredAt: '2026-02-01T00:00:00.000Z' });
    expect(wouldOverdraw(existing, next)).toBe(true);
  });

  it('allows a movement that stays non-negative', () => {
    const existing = [move({ id: 'a', type: 'in', quantity: 9 })];
    const next = move({ id: 'b', type: 'out', quantity: 9, occurredAt: '2026-02-01T00:00:00.000Z' });
    expect(wouldOverdraw(existing, next)).toBe(false);
  });
});

describe('deriveStockByItem', () => {
  it('computes stock per item independently', () => {
    const stock = deriveStockByItem([
      move({ id: 'a', itemId: 'apples', type: 'in', quantity: 10 }),
      move({ id: 'b', itemId: 'pears', type: 'in', quantity: 4 }),
      move({ id: 'c', itemId: 'apples', type: 'out', quantity: 3, occurredAt: '2026-01-05T00:00:00.000Z' }),
    ]);
    expect(stock).toEqual({ apples: 7, pears: 4 });
  });
});

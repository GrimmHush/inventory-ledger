import type { Movement } from './types';

export class InvalidMovementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMovementError';
  }
}

export class OverdrawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverdrawError';
  }
}

/** The signed effect a movement has on stock. */
export function movementEffect(movement: Movement): number {
  switch (movement.type) {
    case 'in':
      return movement.quantity;
    case 'out':
      return -movement.quantity;
    case 'adjust':
      return movement.quantity;
  }
}

/** Throws InvalidMovementError if the movement is structurally invalid. */
export function validateMovement(movement: Movement): void {
  if (!Number.isFinite(movement.quantity)) {
    throw new InvalidMovementError('quantity must be a finite number');
  }
  if (movement.type === 'in' || movement.type === 'out') {
    if (movement.quantity <= 0) {
      throw new InvalidMovementError(
        `${movement.type} movements require a positive quantity`,
      );
    }
  } else if (movement.quantity === 0) {
    throw new InvalidMovementError(
      'adjust movements require a non-zero quantity',
    );
  }
}

/** Deterministic ledger order: by occurrence time, then id as a tie-breaker. */
export function sortMovements(movements: readonly Movement[]): Movement[] {
  return [...movements].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) {
      return a.occurredAt < b.occurredAt ? -1 : 1;
    }
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Folds a single item's movements into a current stock figure, validating each
 * and enforcing the core invariant: stock may never go negative at any point in
 * the ledger. Throws OverdrawError if it would.
 */
export function stockFromMovements(movements: readonly Movement[]): number {
  let stock = 0;
  for (const movement of sortMovements(movements)) {
    validateMovement(movement);
    stock += movementEffect(movement);
    if (stock < 0) {
      throw new OverdrawError(
        `movement ${movement.id} would drive stock negative (${stock})`,
      );
    }
  }
  return stock;
}

/** True if appending `next` to `existing` would violate the non-negative invariant. */
export function wouldOverdraw(
  existing: readonly Movement[],
  next: Movement,
): boolean {
  try {
    stockFromMovements([...existing, next]);
    return false;
  } catch (error) {
    if (error instanceof OverdrawError) return true;
    throw error;
  }
}

/** Derives current stock for every item referenced by the given movements. */
export function deriveStockByItem(
  movements: readonly Movement[],
): Record<string, number> {
  const byItem = new Map<string, Movement[]>();
  for (const movement of movements) {
    const list = byItem.get(movement.itemId) ?? [];
    list.push(movement);
    byItem.set(movement.itemId, list);
  }
  const stock: Record<string, number> = {};
  for (const [itemId, list] of byItem) {
    stock[itemId] = stockFromMovements(list);
  }
  return stock;
}

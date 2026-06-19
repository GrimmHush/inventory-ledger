import {
  InvalidMovementError,
  validateMovement,
  wouldOverdraw,
} from '../domain/ledger';
import type { Item, Movement } from '../domain/types';
import type { LedgerState, MergeResult, OpOutcome, SyncOp } from './types';

export function emptyState(): LedgerState {
  return { items: {}, movements: {} };
}

function cloneState(state: LedgerState): LedgerState {
  return { items: { ...state.items }, movements: { ...state.movements } };
}

/** Deterministic op order: by client timestamp, then client sequence, then id. */
function sortOps(ops: readonly SyncOp[]): SyncOp[] {
  return [...ops].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.clientSeq !== b.clientSeq) return a.clientSeq - b.clientSeq;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

function movementsForItem(state: LedgerState, itemId: string): Movement[] {
  return Object.values(state.movements).filter((m) => m.itemId === itemId);
}

/**
 * Reconciles a batch of client ops against base state. Pure: returns a new
 * state and a per-op outcome, mutating nothing. This is the function that makes
 * offline-first safe, and the one worth reading first.
 *
 * - Movements are an append-only log keyed by id, so concurrent additions from
 *   different clients merge with no conflict and replays are idempotent.
 * - Item metadata is mutable, so concurrent edits resolve last-write-wins by
 *   `updatedAt`.
 * - Integrity is enforced at merge time: a movement that would overdraw stock
 *   once another client's movements are folded in is rejected, not silently
 *   applied — which is exactly the case a naive last-write-wins would get wrong.
 */
export function merge(base: LedgerState, ops: readonly SyncOp[]): MergeResult {
  const state = cloneState(base);
  const outcomes: OpOutcome[] = [];

  for (const op of sortOps(ops)) {
    outcomes.push(
      op.kind === 'upsertItem'
        ? applyUpsert(state, op.id, op.item)
        : applyMovement(state, op.id, op.movement),
    );
  }

  return { state, outcomes };
}

function applyUpsert(state: LedgerState, opId: string, item: Item): OpOutcome {
  const existing = state.items[item.id];
  if (existing && existing.updatedAt > item.updatedAt) {
    return {
      id: opId,
      status: 'superseded',
      reason: 'a newer version of this item already exists',
    };
  }
  state.items[item.id] = item;
  return { id: opId, status: 'applied' };
}

function applyMovement(
  state: LedgerState,
  opId: string,
  movement: Movement,
): OpOutcome {
  if (state.movements[movement.id]) {
    return { id: opId, status: 'duplicate' };
  }
  try {
    validateMovement(movement);
  } catch (error) {
    if (error instanceof InvalidMovementError) {
      return { id: opId, status: 'rejected', reason: error.message };
    }
    throw error;
  }
  if (!state.items[movement.itemId]) {
    return {
      id: opId,
      status: 'rejected',
      reason: `unknown item ${movement.itemId}`,
    };
  }
  if (wouldOverdraw(movementsForItem(state, movement.itemId), movement)) {
    return {
      id: opId,
      status: 'rejected',
      reason: `would drive stock of item ${movement.itemId} negative`,
    };
  }
  state.movements[movement.id] = movement;
  return { id: opId, status: 'applied' };
}

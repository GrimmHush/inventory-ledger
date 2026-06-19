import type { Item, Movement } from '../domain/types';

/** A change made by a client, possibly while offline, awaiting sync. */
export interface UpsertItemOp {
  id: string; // globally unique op id (client-generated)
  kind: 'upsertItem';
  clientSeq: number; // monotonic per client, for deterministic ordering
  createdAt: string; // ISO 8601 client timestamp
  item: Item;
}

export interface AddMovementOp {
  id: string;
  kind: 'addMovement';
  clientSeq: number;
  createdAt: string;
  movement: Movement;
}

export type SyncOp = UpsertItemOp | AddMovementOp;

/** The authoritative state the server holds and clients reconcile against. */
export interface LedgerState {
  items: Record<string, Item>;
  movements: Record<string, Movement>; // keyed by id — gives idempotent replay
}

/**
 * The fate of a single op after merge. Note there are four outcomes, not two:
 * an op can apply, be a stale no-op (superseded), be a harmless replay
 * (duplicate), or fail an integrity check (rejected). Surfacing all four lets a
 * client reason about exactly what happened to each pending change.
 */
export type OpOutcome =
  | { id: string; status: 'applied' }
  | { id: string; status: 'superseded'; reason: string }
  | { id: string; status: 'duplicate' }
  | { id: string; status: 'rejected'; reason: string };

export interface MergeResult {
  state: LedgerState;
  outcomes: OpOutcome[];
}

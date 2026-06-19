/** A stocked product. Mutable metadata; merged across clients with last-write-wins. */
export interface Item {
  id: string;
  sku: string;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601 — drives last-write-wins on metadata
}

/**
 * A single, immutable change to stock. The ledger is append-only: current
 * stock is always *derived* from the full list of movements, never stored.
 * This is what makes the model conflict-free across offline clients — two
 * clients adding different movements simply merge, with no lost writes.
 */
export interface Movement {
  id: string;
  itemId: string;
  type: MovementType;
  /**
   * For `in` / `out` this is a positive magnitude.
   * For `adjust` this is a signed correction (may be negative, never zero).
   */
  quantity: number;
  reason?: string;
  occurredAt: string; // ISO 8601 — defines ledger ordering
}

export type MovementType = 'in' | 'out' | 'adjust';

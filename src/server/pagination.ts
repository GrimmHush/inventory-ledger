// Cursor-based (keyset) pagination. Preferred over offset for an append-only
// log: a cursor names a position by sort key, so it stays stable as rows are
// inserted and the database can seek to it via an index instead of counting.

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Page<T> {
  data: T[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
}

/** Sort key for the items list: ascending by id. */
export interface ItemCursor {
  id: string;
}

/** Sort key for an item's ledger: ascending by occurredAt, then id. */
export interface MovementCursor {
  occurredAt: string;
  id: string;
}

export interface ItemsPageParams {
  limit: number;
  cursor: ItemCursor | null;
}

export interface MovementsPageParams {
  limit: number;
  cursor: MovementCursor | null;
}

/** Encodes a sort key as an opaque, URL-safe cursor string. */
export function encodeCursor(key: Record<string, string>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** Decodes a cursor back to its key, or `undefined` if it is malformed. */
export function decodeCursor(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** True if `movement`'s key sorts strictly after the cursor (ledger order). */
export function isAfterMovementCursor(
  movement: { occurredAt: string; id: string },
  cursor: MovementCursor,
): boolean {
  if (movement.occurredAt !== cursor.occurredAt) {
    return movement.occurredAt > cursor.occurredAt;
  }
  return movement.id > cursor.id;
}

import type { Item, Movement } from '../domain/types';
import type { OpOutcome, SyncOp } from '../sync/types';
import type { ItemWithStock } from '../server/store';

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests or non-standard runtimes; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Thrown for transport- and validation-level failures the caller cannot act on
 * as a business outcome: a malformed body (400, `body.issues` holds the zod
 * issues), a missing/invalid key (401), or a server error (5xx). Business
 * outcomes — a superseded edit or a rejected movement — are returned as values,
 * not thrown. `body` is the parsed JSON payload, when there is one.
 */
export class InventoryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'InventoryApiError';
  }
}

/** Pagination controls for the list endpoints. `cursor` comes from a prior `nextCursor`. */
export interface PageQuery {
  limit?: number;
  cursor?: string;
}

/** Builds a `?limit=&cursor=` query string, or '' when there's nothing to add. */
function query(params?: PageQuery): string {
  if (!params) return '';
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor !== undefined) search.set('cursor', params.cursor);
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** The superseded branch of an op outcome (stale last-write-wins edit). */
export type SupersededOutcome = Extract<OpOutcome, { status: 'superseded' }>;

/**
 * Result of an upsert: the stored item when the edit won, or the superseded
 * outcome when a newer version already existed. Discriminate with `'item' in r`.
 */
export type UpsertItemResult = { item: Item } | SupersededOutcome;

/**
 * A small, fully typed client over the inventory API. Every method's return
 * type flows from the same domain model the server uses, so the contract is
 * checked at compile time rather than discovered at runtime.
 */
export class InventoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * List items (ascending by id) with derived stock. Pass `limit`/`cursor` to
   * page; `nextCursor` is non-null when more pages remain.
   */
  listItems(
    params?: PageQuery,
  ): Promise<{ items: ItemWithStock[]; nextCursor: string | null }> {
    return this.request(`/api/items${query(params)}`, { method: 'GET' }, [200]);
  }

  /**
   * Fetch a page of one item's movements in ledger order. Throws
   * `InventoryApiError` (404) if the item is unknown.
   */
  listMovements(
    itemId: string,
    params?: PageQuery,
  ): Promise<{ movements: Movement[]; nextCursor: string | null }> {
    return this.request(
      `/api/items/${encodeURIComponent(itemId)}/movements${query(params)}`,
      { method: 'GET' },
      [200],
    );
  }

  /**
   * Upsert item metadata. Returns the stored `{ item }` (201) or, if a newer
   * version already existed, the `superseded` outcome (409) — never throws on
   * that conflict, since it is a normal last-write-wins result.
   */
  upsertItem(item: Item): Promise<UpsertItemResult> {
    return this.request('/api/items', { method: 'POST', body: item }, [201, 409]);
  }

  /**
   * Append a movement (its optional `reason` is carried through). Returns the
   * op outcome: `applied`/`duplicate` (201) or `rejected` (422, e.g. an
   * overdraw or an invalid movement). Rejection is a value here, not an error.
   */
  addMovement(movement: Movement): Promise<OpOutcome> {
    return this.request('/api/movements', { method: 'POST', body: movement }, [201, 422]);
  }

  /**
   * Push a batch of offline ops and receive the per-op outcomes (the
   * authoritative result of each). Re-read state via the list endpoints.
   */
  sync(ops: SyncOp[]): Promise<{ outcomes: OpOutcome[] }> {
    return this.request('/api/sync', { method: 'POST', body: { ops } }, [200]);
  }

  private async request<T>(
    path: string,
    options: { method: string; body?: unknown },
    expectedStatuses: number[],
  ): Promise<T> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method: options.method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;

    if (!expectedStatuses.includes(response.status)) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `request to ${path} failed with status ${response.status}`;
      throw new InventoryApiError(message, response.status, body);
    }

    return body as T;
  }
}

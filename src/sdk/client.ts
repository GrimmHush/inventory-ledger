import type { Item, Movement } from '../domain/types';
import type { MergeResult, SyncOp } from '../sync/types';
import type { ItemWithStock } from '../server/store';

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests or non-standard runtimes; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export class InventoryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'InventoryApiError';
  }
}

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

  listItems(): Promise<{ items: ItemWithStock[] }> {
    return this.request('/api/items', { method: 'GET' });
  }

  upsertItem(item: Item): Promise<{ item: Item }> {
    return this.request('/api/items', { method: 'POST', body: item });
  }

  addMovement(movement: Movement): Promise<{ id: string; status: string }> {
    return this.request('/api/movements', { method: 'POST', body: movement });
  }

  /** Push a batch of offline ops and receive the reconciled result. */
  sync(ops: SyncOp[]): Promise<MergeResult> {
    return this.request('/api/sync', { method: 'POST', body: { ops } });
  }

  private async request<T>(
    path: string,
    options: { method: string; body?: unknown },
  ): Promise<T> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method: options.method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw new InventoryApiError(
        `request to ${path} failed`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}

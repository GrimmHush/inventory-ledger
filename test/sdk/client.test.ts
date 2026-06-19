import { describe, expect, it } from 'vitest';
import { InventoryApiError, InventoryClient } from '../../src/sdk/client';
import type { Item, Movement } from '../../src/domain/types';

type Call = { url: string; init: RequestInit };

/** A fake `fetch` that records calls and replies with a JSON Response. */
function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const item: Item = {
  id: 'widget',
  sku: 'widget-1',
  name: 'Widget',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const movement: Movement = {
  id: 'm1',
  itemId: 'widget',
  type: 'in',
  quantity: 5,
  reason: 'restock',
  occurredAt: '2026-01-02T00:00:00.000Z',
};

function client(handler: (call: Call) => Response) {
  const { fn, calls } = fakeFetch(handler);
  return {
    client: new InventoryClient({
      baseUrl: 'http://example.test/',
      apiKey: 'test-key',
      fetch: fn,
    }),
    calls,
  };
}

describe('InventoryClient', () => {
  it('lists items with derived stock', async () => {
    const { client: c, calls } = client(() =>
      json(200, { items: [{ ...item, stock: 5 }] }),
    );
    const res = await c.listItems();
    expect(res.items[0]?.stock).toBe(5);
    // trailing slash on baseUrl is trimmed; key + content-type are set
    expect(calls[0]?.url).toBe('http://example.test/api/items');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
  });

  it('returns the stored item when an upsert is applied', async () => {
    const { client: c } = client(() => json(201, { item }));
    const res = await c.upsertItem(item);
    expect('item' in res).toBe(true);
    if ('item' in res) expect(res.item.id).toBe('widget');
  });

  it('returns the superseded outcome (409) instead of throwing', async () => {
    const { client: c } = client(() =>
      json(409, { id: 'widget', status: 'superseded', reason: 'newer exists' }),
    );
    const res = await c.upsertItem(item);
    expect('item' in res).toBe(false);
    if (!('item' in res)) {
      expect(res.status).toBe('superseded');
      expect(res.reason).toBe('newer exists');
    }
  });

  it('carries a movement reason through and returns the applied outcome', async () => {
    const { client: c, calls } = client(() =>
      json(201, { id: 'm1', status: 'applied' }),
    );
    const res = await c.addMovement(movement);
    expect(res.status).toBe('applied');
    const sent = JSON.parse(calls[0]?.init.body as string) as Movement;
    expect(sent.reason).toBe('restock');
  });

  it('returns a rejected outcome (422) as a value, not an error', async () => {
    const { client: c } = client(() =>
      json(422, { id: 'm2', status: 'rejected', reason: 'would drive stock negative' }),
    );
    const res = await c.addMovement({ ...movement, id: 'm2', type: 'out', quantity: 99 });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.reason).toContain('negative');
  });

  it('throws with the parsed zod issues on a 400', async () => {
    const issues = [{ path: ['sku'], message: 'Required' }];
    const { client: c } = client(() =>
      json(400, { error: 'invalid request body', issues }),
    );
    await expect(c.upsertItem(item)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(InventoryApiError);
      const e = err as InventoryApiError;
      expect(e.status).toBe(400);
      expect(e.message).toBe('invalid request body');
      expect((e.body as { issues: unknown[] }).issues).toHaveLength(1);
      return true;
    });
  });

  it('throws a 401 when the key is rejected', async () => {
    const { client: c } = client(() => json(401, { error: 'invalid or missing API key' }));
    await expect(c.listItems()).rejects.toMatchObject({
      name: 'InventoryApiError',
      status: 401,
    });
  });
});

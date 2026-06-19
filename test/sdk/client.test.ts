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

  it('lists an item movements and url-encodes the id', async () => {
    const { client: c, calls } = client(() =>
      json(200, { movements: [movement], nextCursor: null }),
    );
    const res = await c.listMovements('a/b');
    expect(res.movements[0]?.id).toBe('m1');
    expect(res.nextCursor).toBeNull();
    expect(calls[0]?.url).toBe('http://example.test/api/items/a%2Fb/movements');
  });

  it('passes limit and cursor as query params and returns nextCursor', async () => {
    const { client: c, calls } = client(() =>
      json(200, { items: [{ ...item, stock: 0 }], nextCursor: 'next123' }),
    );
    const res = await c.listItems({ limit: 2, cursor: 'abc' });
    expect(res.nextCursor).toBe('next123');
    expect(calls[0]?.url).toBe('http://example.test/api/items?limit=2&cursor=abc');
  });

  it('iterates every item across pages, following nextCursor', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [{ ...item, id: 'a', stock: 1 }], nextCursor: 'c1' },
      c1: { items: [{ ...item, id: 'b', stock: 2 }], nextCursor: 'c2' },
      c2: { items: [{ ...item, id: 'c', stock: 3 }], nextCursor: null },
    };
    const { client: c, calls } = client((call) => {
      const cursor = new URL(call.url).searchParams.get('cursor') ?? '';
      return json(200, pages[cursor]);
    });

    const ids: string[] = [];
    for await (const it of c.iterateItems()) ids.push(it.id);

    expect(ids).toEqual(['a', 'b', 'c']);
    // one request per page; stops when nextCursor is null
    expect(calls).toHaveLength(3);
    expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('c1');
  });

  it('passes the page-size limit through while iterating movements', async () => {
    const { client: c, calls } = client(() =>
      json(200, { movements: [movement], nextCursor: null }),
    );

    const collected: string[] = [];
    for await (const m of c.iterateMovements('widget', { limit: 10 })) {
      collected.push(m.id);
    }

    expect(collected).toEqual(['m1']);
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('10');
  });

  it('propagates a 404 from the first page of iterateMovements', async () => {
    const { client: c } = client(() => json(404, { error: 'unknown item nope' }));
    const iterator = c.iterateMovements('nope');
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'InventoryApiError',
      status: 404,
    });
  });

  it('throws a 404 when listing movements for an unknown item', async () => {
    const { client: c } = client(() => json(404, { error: 'unknown item nope' }));
    await expect(c.listMovements('nope')).rejects.toMatchObject({
      name: 'InventoryApiError',
      status: 404,
    });
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

  it('sync returns per-op outcomes', async () => {
    const { client: c, calls } = client(() =>
      json(200, { outcomes: [{ id: 'op1', status: 'applied' }] }),
    );
    const res = await c.sync([
      {
        id: 'op1',
        kind: 'upsertItem',
        clientSeq: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        item,
      },
    ]);
    expect(res.outcomes[0]?.status).toBe('applied');
    expect(calls[0]?.url).toBe('http://example.test/api/sync');
  });

  it('throws a 401 when the key is rejected', async () => {
    const { client: c } = client(() => json(401, { error: 'invalid or missing API key' }));
    await expect(c.listItems()).rejects.toMatchObject({
      name: 'InventoryApiError',
      status: 401,
    });
  });
});

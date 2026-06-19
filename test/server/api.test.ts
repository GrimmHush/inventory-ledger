import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app';
import type { LedgerStore } from '../../src/server/store';

const API_KEY = 'test-key';

function app() {
  return createApp({ apiKey: API_KEY });
}

/** A store whose every method rejects, to exercise the error handler. */
function failingStore(): LedgerStore {
  const boom = () => Promise.reject(new Error('boom'));
  return {
    upsertItem: boom,
    addMovement: boom,
    applyOps: boom,
    items: boom,
    itemMovements: boom,
    snapshot: boom,
    ping: boom,
  };
}

describe('inventory API', () => {
  it('serves health without a key when the store is reachable', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('reports 503 from health when the store is unreachable', async () => {
    const server = createApp({ apiKey: API_KEY, store: failingStore() });
    const res = await request(server).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'store unavailable' });
  });

  it('rejects API calls without a valid key', async () => {
    const res = await request(app()).get('/api/items');
    expect(res.status).toBe(401);
  });

  it('creates an item and a movement, then derives stock on list', async () => {
    const server = app();

    await request(server)
      .post('/api/items')
      .set('x-api-key', API_KEY)
      .send({
        id: 'widget',
        sku: 'WIidget-1'.toLowerCase(),
        name: 'Widget',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
      .expect(201);

    await request(server)
      .post('/api/movements')
      .set('x-api-key', API_KEY)
      .send({
        id: 'm1',
        itemId: 'widget',
        type: 'in',
        quantity: 12,
        occurredAt: '2026-01-02T00:00:00.000Z',
      })
      .expect(201);

    const list = await request(server).get('/api/items').set('x-api-key', API_KEY).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].stock).toBe(12);
  });

  it('lists an item movements in ledger order', async () => {
    const server = app();
    await request(server)
      .post('/api/items')
      .set('x-api-key', API_KEY)
      .send({
        id: 'widget',
        sku: 'widget-1',
        name: 'Widget',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

    // Posted out of order; the response must come back in ledger order.
    for (const m of [
      { id: 'm2', occurredAt: '2026-01-03T00:00:00.000Z', quantity: 4 },
      { id: 'm1', occurredAt: '2026-01-02T00:00:00.000Z', quantity: 10 },
    ]) {
      await request(server)
        .post('/api/movements')
        .set('x-api-key', API_KEY)
        .send({ id: m.id, itemId: 'widget', type: 'in', quantity: m.quantity, occurredAt: m.occurredAt });
    }

    const res = await request(server)
      .get('/api/items/widget/movements')
      .set('x-api-key', API_KEY)
      .expect(200);
    expect(res.body.movements.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
  });

  it('returns 404 listing movements for an unknown item', async () => {
    const res = await request(app())
      .get('/api/items/nope/movements')
      .set('x-api-key', API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nope');
  });

  it('returns 422 when a movement would overdraw', async () => {
    const server = app();
    await request(server)
      .post('/api/items')
      .set('x-api-key', API_KEY)
      .send({
        id: 'widget',
        sku: 'widget-1',
        name: 'Widget',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

    const res = await request(server)
      .post('/api/movements')
      .set('x-api-key', API_KEY)
      .send({
        id: 'm1',
        itemId: 'widget',
        type: 'out',
        quantity: 3,
        occurredAt: '2026-01-02T00:00:00.000Z',
      });

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('rejected');
  });

  it('returns 400 for a structurally invalid item body', async () => {
    const res = await request(app())
      .post('/api/items')
      .set('x-api-key', API_KEY)
      .send({ id: 'widget', name: 'Widget' }); // missing sku + timestamps

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid request body');
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('returns 400 for a movement with a bad enum / timestamp', async () => {
    const res = await request(app())
      .post('/api/movements')
      .set('x-api-key', API_KEY)
      .send({
        id: 'm1',
        itemId: 'widget',
        type: 'sideways', // not in | out | adjust
        quantity: 1.5, // not an integer
        occurredAt: 'not-a-date',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid request body');
  });

  it('rejects a sync batch whose ops are malformed with 400', async () => {
    const res = await request(app())
      .post('/api/sync')
      .set('x-api-key', API_KEY)
      .send({ ops: [{ kind: 'upsertItem' }] }); // missing id, clientSeq, item, ...

    expect(res.status).toBe(400);
  });

  it('returns a JSON 500 when the store throws unexpectedly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = createApp({ apiKey: API_KEY, store: failingStore() });

    const res = await request(server).get('/api/items').set('x-api-key', API_KEY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    expect(res.type).toMatch(/json/);
    errorSpy.mockRestore();
  });
});

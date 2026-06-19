import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app';

const API_KEY = 'test-key';

function app() {
  return createApp({ apiKey: API_KEY });
}

describe('inventory API', () => {
  it('serves health without a key', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
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
});

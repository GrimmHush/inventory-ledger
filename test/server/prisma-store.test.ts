import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/server/app';
import { createPrismaClient } from '../../src/server/prisma';
import { PrismaLedgerStore } from '../../src/server/prisma-store';
import type { Item, Movement } from '../../src/domain/types';

const API_KEY = 'test-key';
const databaseUrl = process.env.DATABASE_URL;

function item(partial: Partial<Item> & Pick<Item, 'id'>): Item {
  return {
    sku: partial.id,
    name: partial.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function move(partial: Partial<Movement> & Pick<Movement, 'id' | 'type'>): Movement {
  return {
    itemId: 'widget',
    quantity: 1,
    occurredAt: '2026-01-02T00:00:00.000Z',
    ...partial,
  };
}

// Gated on DATABASE_URL: runs locally against the docker Postgres (see
// docker-compose.yml + `npx prisma db push`), and is skipped in CI where no
// database is provisioned. The schema is assumed already pushed.
describe.skipIf(!databaseUrl)('PrismaLedgerStore (integration)', () => {
  let prisma: PrismaClient;
  let store: PrismaLedgerStore;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl!);
    store = new PrismaLedgerStore(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.movement.deleteMany();
    await prisma.item.deleteMany();
  });

  it('ping resolves against a reachable database', async () => {
    await expect(store.ping()).resolves.toBeUndefined();
  });

  it('persists an item and a movement, then derives stock', async () => {
    await store.upsertItem(item({ id: 'widget' }));
    const applied = await store.addMovement(
      move({ id: 'm1', type: 'in', quantity: 12, reason: 'restock' }),
    );
    expect(applied.outcomes[0]).toEqual({ id: 'm1', status: 'applied' });

    const items = await store.items();
    expect(items).toHaveLength(1);
    expect(items[0]?.stock).toBe(12);

    // round-trips through Postgres, including the optional reason
    const fresh = new PrismaLedgerStore(prisma);
    const reloaded = await fresh.snapshot();
    expect(reloaded.movements.m1?.reason).toBe('restock');
  });

  it('returns an item movements in ledger order, null for unknown items', async () => {
    await store.upsertItem(item({ id: 'widget' }));
    await store.addMovement(
      move({ id: 'm2', type: 'in', quantity: 4, occurredAt: '2026-01-03T00:00:00.000Z' }),
    );
    await store.addMovement(
      move({ id: 'm1', type: 'in', quantity: 10, occurredAt: '2026-01-02T00:00:00.000Z' }),
    );

    const movements = await store.itemMovements('widget');
    expect(movements?.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(await store.itemMovements('nope')).toBeNull();
  });

  it('rejects an overdraw at merge time and does not persist it', async () => {
    await store.upsertItem(item({ id: 'widget' }));
    await store.addMovement(move({ id: 'm1', type: 'in', quantity: 12 }));

    const res = await store.addMovement(
      move({ id: 'm2', type: 'out', quantity: 99, occurredAt: '2026-01-03T00:00:00.000Z' }),
    );
    expect(res.outcomes[0]?.status).toBe('rejected');

    const count = await prisma.movement.count();
    expect(count).toBe(1);
  });

  it('treats a replayed movement id as an idempotent duplicate', async () => {
    await store.upsertItem(item({ id: 'widget' }));
    await store.addMovement(move({ id: 'm1', type: 'in', quantity: 12 }));
    const replay = await store.addMovement(move({ id: 'm1', type: 'in', quantity: 12 }));

    expect(replay.outcomes[0]?.status).toBe('duplicate');
    expect(await prisma.movement.count()).toBe(1);
  });

  it('reports a stale item edit as superseded (last-write-wins)', async () => {
    await store.upsertItem(
      item({ id: 'widget', name: 'New', updatedAt: '2026-02-01T00:00:00.000Z' }),
    );
    const stale = await store.upsertItem(
      item({ id: 'widget', name: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' }),
    );

    expect(stale.outcomes[0]?.status).toBe('superseded');
    const items = await store.items();
    expect(items[0]?.name).toBe('New');
  });

  it('serves the full HTTP path through the Postgres store', async () => {
    const app = createApp({ apiKey: API_KEY, store });

    await request(app)
      .post('/api/items')
      .set('x-api-key', API_KEY)
      .send(item({ id: 'widget' }))
      .expect(201);

    await request(app)
      .post('/api/movements')
      .set('x-api-key', API_KEY)
      .send(move({ id: 'm1', type: 'in', quantity: 5 }))
      .expect(201);

    const overdraw = await request(app)
      .post('/api/movements')
      .set('x-api-key', API_KEY)
      .send(move({ id: 'm2', type: 'out', quantity: 9, occurredAt: '2026-01-03T00:00:00.000Z' }));
    expect(overdraw.status).toBe(422);

    const list = await request(app).get('/api/items').set('x-api-key', API_KEY).expect(200);
    expect(list.body.items[0].stock).toBe(5);
  });
});

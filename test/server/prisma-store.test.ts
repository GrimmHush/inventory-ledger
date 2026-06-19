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

  it('keeps the stock checkpoint consistent with the movement log', async () => {
    await store.upsertItem(item({ id: 'widget' }));
    await store.addMovement(
      move({ id: 'm1', type: 'in', quantity: 10, occurredAt: '2026-01-02T00:00:00.000Z' }),
    );
    await store.addMovement(
      move({ id: 'm2', type: 'out', quantity: 4, occurredAt: '2026-01-03T00:00:00.000Z' }),
    );
    await store.addMovement(
      move({ id: 'm3', type: 'adjust', quantity: -1, occurredAt: '2026-01-04T00:00:00.000Z' }),
    );

    const items = await store.items();
    expect(items[0]?.stock).toBe(5); // 10 - 4 - 1

    // The cached column equals folding the log, and items() reads it directly.
    const row = await prisma.item.findUniqueOrThrow({ where: { id: 'widget' } });
    expect(row.stock).toBe(5);
  });

  it('still rejects a backdated movement that dips an intermediate prefix negative', async () => {
    await store.upsertItem(item({ id: 'widget' }));
    await store.addMovement(
      move({ id: 'in', type: 'in', quantity: 5, occurredAt: '2026-02-01T00:00:00.000Z' }),
    );

    // A withdrawal of 3 backdated *before* the only deposit: at that instant
    // stock would be -3, even though the final total (5 - 3 = 2) is fine. The
    // per-prefix invariant must reject it — a final-stock-only checkpoint would
    // wrongly accept. This proves the scoped read still folds the full per-item
    // log, not just a cached total.
    const res = await store.addMovement(
      move({ id: 'back', type: 'out', quantity: 3, occurredAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(res.outcomes[0]?.status).toBe('rejected');

    const items = await store.items();
    expect(items[0]?.stock).toBe(5); // unchanged; the backdated out was not applied
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

  it('serializes concurrent overdrawing writes: one wins, one is rejected', async () => {
    await store.upsertItem(item({ id: 'widget' }));
    await store.addMovement(move({ id: 'in', type: 'in', quantity: 5 }));

    // Two withdrawals of the full stock fired at once. Each is valid against a
    // stock of 5 read in isolation, so a naive read-outside-the-transaction
    // store would commit both and drive stock to -5.
    const [a, b] = await Promise.all([
      store.addMovement(
        move({ id: 'outA', type: 'out', quantity: 5, occurredAt: '2026-01-03T00:00:00.000Z' }),
      ),
      store.addMovement(
        move({ id: 'outB', type: 'out', quantity: 5, occurredAt: '2026-01-04T00:00:00.000Z' }),
      ),
    ]);

    const statuses = [a.outcomes[0]?.status, b.outcomes[0]?.status].sort();
    expect(statuses).toEqual(['applied', 'rejected']);

    // The invariant held at the database: exactly one withdrawal persisted and
    // stock never went negative.
    const items = await store.items();
    expect(items[0]?.stock).toBe(0);
    expect(await prisma.movement.count()).toBe(2);
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

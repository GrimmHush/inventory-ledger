/**
 * A runnable walkthrough of the offline -> queue -> reconcile flow — the same
 * thesis the test suite asserts, shown end to end instead.
 *
 * Nothing here is mocked. It starts the real Express API (in-memory store) in
 * process, talks to it through the real `InventoryClient` over real HTTP, and
 * predicts offline stock with the *same* pure `merge` / `deriveStockByItem` the
 * server runs — exactly what the browser client in `web/` does. The only
 * concession to a readable transcript is deterministic ids and timestamps
 * (normally `crypto.randomUUID()` and `Date.now()`).
 *
 * Run it with `npm run demo`.
 */
import type { AddressInfo } from 'node:net';
import {
  InventoryClient,
  deriveStockByItem,
  emptyState,
  merge,
  type LedgerState,
  type Movement,
  type OpOutcome,
  type SyncOp,
} from '../src/index';
import { createApp } from '../src/server/app';
import { InMemoryLedgerStore } from '../src/server/store';

/** Omit a key across each member of the union (a plain Omit collapses to common keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const ITEM_ID = 'bolt';
// A fixed clock so the transcript is reproducible; ops still sort by these.
const T = (m: string) => `2026-06-21T${m}:00.000Z`;

// --- tiny presentation helpers -------------------------------------------------

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n  ${title}\n${'='.repeat(74)}`);
}
function log(prefix: string, msg: string): void {
  console.log(`  ${prefix.padEnd(9)} ${msg}`);
}

/**
 * A device with its own outbox and its own last-known view of the server (the
 * "mirror"). It folds the outbox over the mirror with the shared `merge`, so the
 * stock it shows while offline is computed by the very code the server will run.
 */
class Device {
  private seq = 0;
  private mirror: LedgerState = emptyState();
  readonly outbox: SyncOp[] = [];

  constructor(private readonly client: InventoryClient) {}

  /** Re-read authoritative state from the server and adopt it as the mirror. */
  async refresh(): Promise<void> {
    this.mirror = await readMirror(this.client);
  }

  /** Queue an op locally, as happens while offline. `clientSeq` is assigned now. */
  queue(op: DistributiveOmit<SyncOp, 'clientSeq'>): SyncOp {
    const full = { ...op, clientSeq: ++this.seq } as SyncOp;
    this.outbox.push(full);
    return full;
  }

  /** The stock this device *displays*: mirror folded with its pending outbox. */
  optimisticStock(): number {
    const { state } = merge(this.mirror, this.outbox);
    return deriveStockByItem(Object.values(state.movements))[ITEM_ID] ?? 0;
  }

  itemName(): string {
    const { state } = merge(this.mirror, this.outbox);
    return state.items[ITEM_ID]?.name ?? '(none)';
  }

  /** Flush the outbox to the server and return the per-op outcomes. */
  async flush(): Promise<OpOutcome[]> {
    const { outcomes } = await this.client.sync(this.outbox);
    // Settle the outbox the way the real controller does: applied/duplicate are
    // dropped; rejected/superseded stay as conflicts for the user to resolve.
    const byId = new Map(outcomes.map((o) => [o.id, o]));
    const kept = this.outbox.filter((op) => {
      const status = byId.get(op.id)?.status;
      return status === 'rejected' || status === 'superseded';
    });
    this.outbox.length = 0;
    this.outbox.push(...kept);
    return outcomes;
  }

  /** Re-send a single op as if a dropped response forced an at-least-once retry. */
  async replay(op: SyncOp): Promise<OpOutcome[]> {
    const { outcomes } = await this.client.sync([op]);
    return outcomes;
  }
}

function printOutcome(o: OpOutcome): void {
  const reason = 'reason' in o ? ` — ${o.reason}` : '';
  const mark =
    o.status === 'applied' ? 'ok ' : o.status === 'duplicate' ? '~  ' : '!! ';
  log('', `${mark}${o.id.padEnd(13)} ${o.status.toUpperCase()}${reason}`);
}

/** Rebuild a client's mirror from the paginated reads (sync returns outcomes only). */
async function readMirror(client: InventoryClient): Promise<LedgerState> {
  const state = emptyState();
  for await (const item of client.iterateItems()) {
    const { stock: _stock, ...rest } = item;
    state.items[item.id] = rest;
  }
  for (const id of Object.keys(state.items)) {
    for await (const m of client.iterateMovements(id)) state.movements[m.id] = m;
  }
  return state;
}

async function main(): Promise<void> {
  const apiKey = 'dev-key';
  const server = createApp({ apiKey, store: new InMemoryLedgerStore() }).listen(0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;
  const seedClient = new InventoryClient({ baseUrl, apiKey });
  const phone = new Device(new InventoryClient({ baseUrl, apiKey }));
  const tablet = new Device(new InventoryClient({ baseUrl, apiKey }));

  try {
    // -- Act 1: online baseline ------------------------------------------------
    section('1. Online: one source of truth, stock derived from the ledger');
    await seedClient.upsertItem({
      id: ITEM_ID,
      sku: 'BLT-M6',
      name: 'Bolt M6',
      createdAt: T('09:00'),
      updatedAt: T('09:00'),
    });
    await seedClient.addMovement({
      id: 'seed-in',
      itemId: ITEM_ID,
      type: 'in',
      quantity: 100,
      occurredAt: T('09:00'),
    });
    log('online', 'create item bolt (Bolt M6), receive 100 in');

    const baseline = await readMirror(seedClient);
    await phone.refresh();
    await tablet.refresh();
    const baselineStock =
      deriveStockByItem(Object.values(baseline.movements))[ITEM_ID] ?? 0;
    log('online', `server stock = ${baselineStock}`);
    log('', 'both devices sync, then lose connectivity ↓');

    // -- Act 2: offline, queue locally, stock updates optimistically -----------
    section('2. Offline: each device queues actions; stock folds locally');

    phone.queue({
      id: 'phone-sell',
      kind: 'addMovement',
      createdAt: T('09:15'),
      movement: mv('phone-sell', 'out', 70, T('09:15')),
    });
    log('phone', `sells 70  → optimistic stock ${phone.optimisticStock()} (outbox: ${phone.outbox.length})`);

    tablet.queue({
      id: 'tablet-rename',
      kind: 'upsertItem',
      createdAt: T('09:18'),
      item: {
        id: ITEM_ID,
        sku: 'BLT-M6',
        name: 'Bolt M6 (steel)',
        createdAt: T('09:00'),
        updatedAt: T('09:18'),
      },
    });
    tablet.queue({
      id: 'tablet-sell',
      kind: 'addMovement',
      createdAt: T('09:20'),
      movement: mv('tablet-sell', 'out', 60, T('09:20')),
    });
    log('tablet', `renames → "${tablet.itemName()}", sells 60`);
    log('tablet', `optimistic stock ${tablet.optimisticStock()} (outbox: ${tablet.outbox.length})`);
    log('', "neither device can see the other's pending sale — that's the crux");

    // -- Act 3: phone reconnects first -----------------------------------------
    section('3. Phone reconnects: queue flushes, server reconciles');
    phone.queue({
      id: 'phone-rename',
      kind: 'upsertItem',
      createdAt: T('09:25'),
      item: {
        id: ITEM_ID,
        sku: 'BLT-M6',
        name: 'Bolt M6 (zinc-plated)',
        createdAt: T('09:00'),
        updatedAt: T('09:25'),
      },
    });
    log('phone', 'also renamed offline → "Bolt M6 (zinc-plated)" (updatedAt 09:25)');
    for (const o of await phone.flush()) printOutcome(o);
    await phone.refresh();
    log('phone', `confirmed: stock ${phone.optimisticStock()}, name "${phone.itemName()}"`);

    // Idempotency: an ambiguous network drop makes the client re-send. Safe.
    section('4. At-least-once delivery: a replayed op is a harmless duplicate');
    log('phone', 're-sends the 70-unit sale after a dropped response');
    const replay = await phone.replay({
      id: 'phone-sell',
      kind: 'addMovement',
      clientSeq: 1,
      createdAt: T('09:15'),
      movement: mv('phone-sell', 'out', 70, T('09:15')),
    });
    for (const o of replay) printOutcome(o);

    // -- Act 5: tablet reconnects — the divergence -----------------------------
    section('5. Tablet reconnects: optimism meets reality');
    log('tablet', `showed stock ${tablet.optimisticStock()}, name "${tablet.itemName()}" while offline`);
    log('tablet', 'flushes its 2 queued ops…');
    for (const o of await tablet.flush()) printOutcome(o);
    await tablet.refresh();
    log('tablet', `reality: stock ${tablet.optimisticStock()}, name "${tablet.itemName()}"`);
    log('tablet', `${tablet.outbox.length} op(s) kept as conflicts to resolve (discard or re-record)`);

    section('Recap: every pending change has a known fate');
    console.log(
      [
        '  applied     phone sale + rename committed',
        '  duplicate   the replayed sale was deduped by id (no double-count)',
        "  superseded  tablet's rename lost LWW to phone's newer edit",
        '  rejected    tablet sale would overdraw once both sales are known —',
        '              the exact case naive last-write-wins corrupts silently',
        '',
      ].join('\n'),
    );
  } finally {
    server.close();
  }
}

function mv(id: string, type: Movement['type'], quantity: number, occurredAt: string): Movement {
  return { id, itemId: ITEM_ID, type, quantity, occurredAt };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

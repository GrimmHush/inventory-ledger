import type { OpOutcome } from 'inventory-ledger';
import { store } from '../store';
import type { OutboxRecord } from '../db';
import { ConflictBanner } from './ConflictBanner';

function describe(record: OutboxRecord): string {
  const { op } = record;
  if (op.kind === 'upsertItem') return `item ${op.item.name} (${op.item.sku})`;
  const m = op.movement;
  return `${m.type} ${m.quantity} on ${m.itemId}`;
}

export function OutboxPanel({
  records,
  predicted,
}: {
  records: OutboxRecord[];
  predicted: Record<string, OpOutcome['status']>;
}) {
  const ordered = [...records].sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  const conflicts = ordered.filter((r) => r.status === 'conflict');
  const queued = ordered.filter((r) => r.status !== 'conflict');

  return (
    <section>
      <h2>Outbox ({queued.length})</h2>

      {conflicts.map((record) => (
        <ConflictBanner
          key={record.op.id}
          record={record}
          onDiscard={() => void store.discard(record.op.id)}
        />
      ))}

      {queued.length === 0 ? (
        <p className="muted">Queue empty — everything is synced.</p>
      ) : (
        <ul className="outbox">
          {queued.map((record) => (
            <li key={record.op.id}>
              <span className={`tag tag-${record.status}`}>{record.status}</span>
              <span>{describe(record)}</span>
              {predicted[record.op.id] === 'rejected' && (
                <span className="tag tag-warn">will reject</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import type { OpOutcome } from 'inventory-ledger';
import { store } from '../store';
import type { OutboxRecord } from '../db';
import { ConflictBanner } from './ConflictBanner';

function describe(record: OutboxRecord): string {
  const { op } = record;
  if (op.kind === 'upsertItem') return `${op.item.name} · ${op.item.sku}`;
  const m = op.movement;
  return `${m.type} ${m.quantity} · ${m.itemId.slice(0, 8)}`;
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
    <aside className="panel outbox">
      <div className="panel-head">
        <h2 className="eyebrow">Outbox</h2>
        <span className="count">{queued.length}</span>
      </div>

      {conflicts.length > 0 && (
        <div className="conflicts">
          {conflicts.map((record) => (
            <ConflictBanner
              key={record.op.id}
              record={record}
              onDiscard={() => void store.discard(record.op.id)}
            />
          ))}
        </div>
      )}

      {queued.length === 0 ? (
        <p className="empty">Nothing queued — local changes appear here until they sync.</p>
      ) : (
        <ul className="oplist">
          {queued.map((record) => {
            const willReject = predicted[record.op.id] === 'rejected';
            return (
              <li key={record.op.id} className={`oprow ${willReject ? 'is-warn' : ''}`}>
                <span className={`dot dot-${record.status}`} aria-hidden />
                <span className="op-desc mono">{describe(record)}</span>
                <span className="op-status">{willReject ? 'may reject' : record.status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

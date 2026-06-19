import type { OutboxRecord } from '../db';

function describe(record: OutboxRecord): string {
  const { op } = record;
  if (op.kind === 'upsertItem') return `item ${op.item.name} (${op.item.sku})`;
  const m = op.movement;
  return `${m.type} ${m.quantity} on ${m.itemId}`;
}

/**
 * A terminal-failure op (rejected/superseded). Per the chosen policy it is kept,
 * not dropped, with the server's reason shown so the user can resolve it. Discard
 * removes it; editing-and-requeueing is just adding a fresh op elsewhere.
 */
export function ConflictBanner({
  record,
  onDiscard,
}: {
  record: OutboxRecord;
  onDiscard: () => void;
}) {
  const outcome = record.outcome;
  const reason =
    outcome && 'reason' in outcome && outcome.reason ? outcome.reason : outcome?.status;

  return (
    <div className="conflict">
      <div>
        <strong>{outcome?.status ?? 'conflict'}</strong> — {describe(record)}
        <div className="muted">{reason}</div>
      </div>
      <button onClick={onDiscard}>Discard</button>
    </div>
  );
}

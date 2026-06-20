import type { OutboxRecord } from '../db';

function describe(record: OutboxRecord): string {
  const { op } = record;
  if (op.kind === 'upsertItem') return `${op.item.name} · ${op.item.sku}`;
  const m = op.movement;
  return `${m.type} ${m.quantity} · ${m.itemId.slice(0, 8)}`;
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
      <span className="dot dot-conflict" aria-hidden />
      <div className="conflict-body">
        <div className="conflict-head">
          <span className="conflict-status">{outcome?.status ?? 'conflict'}</span>
          <span className="conflict-desc mono">{describe(record)}</span>
        </div>
        <p className="conflict-reason">{reason}</p>
      </div>
      <button className="btn btn-ghost" onClick={onDiscard}>
        Discard
      </button>
    </div>
  );
}

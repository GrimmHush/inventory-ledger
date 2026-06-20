import { Link, useParams } from 'react-router-dom';
import { movementEffect, sortMovements, type Movement } from 'inventory-ledger';
import { useStore } from '../useStore';
import { ViewHeader } from '../ViewHeader';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function ItemLedgerView() {
  const snap = useStore();
  const { id } = useParams();

  const item = snap.view.items.find((i) => i.id === id);

  // Movement ids still in the outbox (not yet server-confirmed) — shown unconfirmed.
  const pendingIds = new Set(
    snap.records
      .filter((r) => r.status !== 'conflict' && r.op.kind === 'addMovement')
      .map((r) => (r.op.kind === 'addMovement' ? r.op.movement.id : '')),
  );

  // Ledger order is oldest→newest; show newest first so recent activity leads.
  const movements: Movement[] = sortMovements(
    snap.view.movements.filter((m) => m.itemId === id),
  ).reverse();

  return (
    <>
      <ViewHeader
        eyebrow={<Link to="/items" className="crumb">← Items</Link>}
        title={item ? item.name : 'Unknown item'}
        right={
          item && (
            <div className="onhand">
              <span className="onhand-num">{item.stock}</span>
              <span className="onhand-label">on hand</span>
            </div>
          )
        }
      />
      <div className="view-body">
        {!item ? (
          <p className="empty">
            This item isn’t in the local view. <Link to="/items" className="link">Back to items</Link>.
          </p>
        ) : (
          <section className="panel">
            <div className="panel-head">
              <h2 className="eyebrow">Movement ledger</h2>
              <span className="panel-meta mono">{item.sku}</span>
            </div>

            {movements.length === 0 ? (
              <p className="empty">No movements yet. Record one from the Items view.</p>
            ) : (
              <ul className="ledger-feed">
                {movements.map((m) => {
                  const effect = movementEffect(m);
                  const sign = effect > 0 ? 'pos' : effect < 0 ? 'neg' : 'zero';
                  const unconfirmed = pendingIds.has(m.id);
                  return (
                    <li
                      key={m.id}
                      className={`feed-row ${unconfirmed ? 'is-unconfirmed' : ''}`}
                    >
                      <span className={`mtype mtype-${m.type}`}>{m.type}</span>
                      <span className={`mqty mono qty-${sign}`}>
                        {effect > 0 ? `+${effect}` : effect}
                      </span>
                      <span className="mreason">{m.reason ?? <span className="muted">—</span>}</span>
                      {unconfirmed && <span className="mflag">queued</span>}
                      <span className="mdate mono">{formatDate(m.occurredAt)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}

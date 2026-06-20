import { useStore } from '../useStore';
import { ViewHeader } from '../ViewHeader';
import { ItemList } from '../ItemList';
import { MovementForm } from '../MovementForm';

export function ItemsView() {
  const snap = useStore();

  return (
    <>
      <ViewHeader
        title="Items"
        right={!snap.ready ? <span className="muted">Connecting…</span> : undefined}
      />
      <div className="view-body stack">
        {snap.error && <div className="banner-error">{snap.error}</div>}
        <ItemList items={snap.view.items} />
        <MovementForm items={snap.view.items} />
      </div>
    </>
  );
}

import { useSyncExternalStore } from 'react';
import { store } from '../store';
import { ItemList } from './ItemList';
import { MovementForm } from './MovementForm';
import { OutboxPanel } from './OutboxPanel';

export function App() {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <main>
      <header className="topbar">
        <h1>Inventory</h1>
        <span className={`pill ${snap.online ? 'pill-online' : 'pill-offline'}`}>
          {snap.online ? 'online' : 'offline'}
        </span>
        <button onClick={() => void store.flush()} disabled={!snap.online || snap.syncing}>
          {snap.syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      {!snap.ready && <p className="muted">Loading…</p>}
      {snap.error && <p className="error">Sync error: {snap.error}</p>}

      <div className="columns">
        <div>
          <ItemList items={snap.view.items} />
          <MovementForm items={snap.view.items} />
        </div>
        <OutboxPanel records={snap.records} predicted={snap.view.predicted} />
      </div>
    </main>
  );
}

import { useSyncExternalStore } from 'react';
import { store } from '../store';
import { ItemList } from './ItemList';
import { MovementForm } from './MovementForm';
import { OutboxPanel } from './OutboxPanel';

export function App() {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Ledger</span>
          <span className="brand-sub">inventory</span>
        </div>
        <div className="topbar-right">
          <span className={`conn ${snap.online ? 'is-online' : 'is-offline'}`}>
            <span className="conn-dot" aria-hidden />
            {snap.online ? 'Online' : 'Offline'}
          </span>
          <button
            className="btn btn-primary"
            onClick={() => void store.flush()}
            disabled={!snap.online || snap.syncing}
          >
            {snap.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </header>

      {snap.error && <div className="banner-error">{snap.error}</div>}
      {!snap.ready && <div className="loading">Connecting…</div>}

      <main className="content">
        <div className="col-main">
          <ItemList items={snap.view.items} />
          <MovementForm items={snap.view.items} />
        </div>
        <OutboxPanel records={snap.records} predicted={snap.view.predicted} />
      </main>
    </div>
  );
}

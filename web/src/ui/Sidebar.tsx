import { NavLink } from 'react-router-dom';
import { Package, RefreshCw } from './icons';
import { store } from '../store';
import { useStore } from './useStore';

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'navlink is-active' : 'navlink';
}

export function Sidebar() {
  const snap = useStore();
  const queued = snap.records.filter((r) => r.status !== 'conflict').length;
  const conflicts = snap.records.filter((r) => r.status === 'conflict').length;

  return (
    <aside className="sidebar">
      <div className="side-brand">
        <span className="brand-mark" aria-hidden />
        <span className="brand-name">Ledger</span>
      </div>

      <nav className="side-nav">
        <NavLink to="/items" className={navClass}>
          <Package className="nav-icon" size={16} strokeWidth={1.75} aria-hidden />
          Items
          <span className="nav-meta">{snap.view.items.length || ''}</span>
        </NavLink>
        <NavLink to="/sync" className={navClass}>
          <RefreshCw className="nav-icon" size={16} strokeWidth={1.75} aria-hidden />
          Sync
          {(queued > 0 || conflicts > 0) && (
            <span className={`nav-badge ${conflicts > 0 ? 'is-warn' : ''}`}>
              {conflicts > 0 ? conflicts : queued}
            </span>
          )}
        </NavLink>
      </nav>

      <div className="side-foot">
        <span className={`conn ${snap.online ? 'is-online' : 'is-offline'}`}>
          <span className="conn-dot" aria-hidden />
          {snap.online ? 'Online' : 'Offline'}
        </span>
        <button
          className="btn btn-primary btn-block"
          onClick={() => void store.flush()}
          disabled={!snap.online || snap.syncing}
        >
          {snap.syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    </aside>
  );
}

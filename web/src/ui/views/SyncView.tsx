import { store } from '../../store';
import { useStore } from '../useStore';
import { ViewHeader } from '../ViewHeader';
import { OutboxPanel } from '../OutboxPanel';

export function SyncView() {
  const snap = useStore();
  const queued = snap.records.filter((r) => r.status !== 'conflict').length;
  const conflicts = snap.records.filter((r) => r.status === 'conflict').length;

  return (
    <>
      <ViewHeader
        title="Sync"
        right={
          <button
            className="btn btn-primary"
            onClick={() => void store.flush()}
            disabled={!snap.online || snap.syncing}
          >
            {snap.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        }
      />
      <div className="view-body stack">
        {snap.error && <div className="banner-error">{snap.error}</div>}

        <div className="stat-row">
          <div className="stat">
            <span className={`stat-dot ${snap.online ? 'is-online' : 'is-offline'}`} aria-hidden />
            <span className="stat-label">{snap.online ? 'Connected' : 'Offline'}</span>
          </div>
          <div className="stat">
            <span className="stat-num mono">{queued}</span>
            <span className="stat-label">queued</span>
          </div>
          <div className="stat">
            <span className={`stat-num mono ${conflicts > 0 ? 'is-danger' : ''}`}>{conflicts}</span>
            <span className="stat-label">conflicts</span>
          </div>
        </div>

        <OutboxPanel records={snap.records} predicted={snap.view.predicted} />
      </div>
    </>
  );
}

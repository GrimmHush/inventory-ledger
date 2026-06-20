import { Navigate, Route, Routes } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ItemsView } from './views/ItemsView';
import { ItemLedgerView } from './views/ItemLedgerView';
import { SyncView } from './views/SyncView';

export function App() {
  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/items" replace />} />
          <Route path="/items" element={<ItemsView />} />
          <Route path="/items/:id" element={<ItemLedgerView />} />
          <Route path="/sync" element={<SyncView />} />
          <Route path="*" element={<Navigate to="/items" replace />} />
        </Routes>
      </div>
    </div>
  );
}

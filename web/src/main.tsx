import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { store } from './store';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Kick off async setup (open idb, recover, initial read) without blocking render;
// the UI shows a loading state until the snapshot reports `ready`.
void store.init();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

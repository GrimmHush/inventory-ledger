import { useSyncExternalStore } from 'react';
import { store } from '../store';
import type { AppSnapshot } from '../store';

/** Subscribe a component to the app store's immutable snapshot. */
export function useStore(): AppSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

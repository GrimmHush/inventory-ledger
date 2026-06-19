// Provides a real IndexedDB implementation (backed by memory) in the jsdom test
// environment, so the outbox modules run against the same API the browser exposes.
import 'fake-indexeddb/auto';

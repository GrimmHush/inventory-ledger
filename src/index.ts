// Public library surface: the domain model, the sync core, and the typed SDK.
// The Express server is an application (run via `npm run dev`), not exported here.
export * from './domain';
export * from './sync';
export { InventoryClient, InventoryApiError } from './sdk/client';
export type {
  ClientOptions,
  PageQuery,
  UpsertItemResult,
  SupersededOutcome,
} from './sdk/client';
export type { ItemWithStock } from './server/store';

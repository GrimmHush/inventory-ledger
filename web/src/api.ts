import { InventoryClient } from 'inventory-ledger';

// Empty baseUrl => same-origin; Vite's dev proxy forwards /api to the Express API
// (see vite.config.ts), so there's no CORS to configure. Shipping the key to the
// browser is a demo-only shortcut, not a deployment pattern.
const apiKey = import.meta.env.VITE_API_KEY ?? 'dev-key';

export const client = new InventoryClient({ baseUrl: '', apiKey });

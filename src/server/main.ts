import 'dotenv/config';
import { createApp } from './app';
import { createPrismaClient } from './prisma';
import { PrismaLedgerStore } from './prisma-store';
import { InMemoryLedgerStore, type LedgerStore } from './store';

const port = Number(process.env.PORT ?? 3000);
const apiKey = process.env.API_KEY ?? 'dev-key';
const databaseUrl = process.env.DATABASE_URL;

let store: LedgerStore;
if (databaseUrl) {
  store = new PrismaLedgerStore(createPrismaClient(databaseUrl));
  console.log('inventory-ledger using Postgres-backed store');
} else {
  store = new InMemoryLedgerStore();
  console.log('inventory-ledger using in-memory store (set DATABASE_URL for Postgres)');
}

createApp({ apiKey, store }).listen(port, () => {
  console.log(`inventory-ledger listening on http://localhost:${port}`);
});

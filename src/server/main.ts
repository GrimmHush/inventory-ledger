import 'dotenv/config';
import { createApp } from './app';
import { createPrismaClient } from './prisma';
import { PrismaLedgerStore } from './prisma-store';
import { InMemoryLedgerStore, type LedgerStore } from './store';

const port = Number(process.env.PORT ?? 3000);
const apiKey = process.env.API_KEY ?? 'dev-key';
const databaseUrl = process.env.DATABASE_URL;

let store: LedgerStore;
let prisma: ReturnType<typeof createPrismaClient> | undefined;
if (databaseUrl) {
  prisma = createPrismaClient(databaseUrl);
  store = new PrismaLedgerStore(prisma);
  console.log('inventory-ledger using Postgres-backed store');
} else {
  store = new InMemoryLedgerStore();
  console.log('inventory-ledger using in-memory store (set DATABASE_URL for Postgres)');
}

const server = createApp({ apiKey, store }).listen(port, () => {
  console.log(`inventory-ledger listening on http://localhost:${port}`);
});

// Drain in-flight requests, then release the database pool. Guard against a
// second signal, and force-exit if a connection refuses to close in time.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  const forceExit = setTimeout(() => {
    console.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    void (async () => {
      try {
        await prisma?.$disconnect();
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    })();
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

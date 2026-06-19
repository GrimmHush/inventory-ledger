import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Item, Movement } from '../domain/types';
import type { SyncOp } from '../sync/types';
import { InMemoryLedgerStore, type LedgerStore } from './store';

export interface AppOptions {
  apiKey: string;
  store?: LedgerStore;
}

/**
 * Builds the Express app. Takes its dependencies as options so tests can inject
 * a fresh store and a known API key — no globals, no singletons.
 */
export function createApp(options: AppOptions): Express {
  const app = express();
  const store = options.store ?? new InMemoryLedgerStore();

  app.use(express.json());

  // Health check sits before auth so probes don't need a key.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-api-key') !== options.apiKey) {
      res.status(401).json({ error: 'invalid or missing API key' });
      return;
    }
    next();
  });

  app.get('/api/items', (_req, res, next) => {
    store
      .items()
      .then((items) => res.json({ items }))
      .catch(next);
  });

  app.post('/api/items', (req, res, next) => {
    // NOTE: request-body validation (e.g. zod) is a roadmap item; see README.
    const item = req.body as Item;
    store
      .upsertItem(item)
      .then((result) => {
        const [outcome] = result.outcomes;
        if (outcome?.status === 'superseded') {
          res.status(409).json(outcome);
          return;
        }
        res.status(201).json({ item });
      })
      .catch(next);
  });

  app.post('/api/movements', (req, res, next) => {
    store
      .addMovement(req.body as Movement)
      .then((result) => {
        const [outcome] = result.outcomes;
        if (outcome?.status === 'rejected') {
          res.status(422).json(outcome);
          return;
        }
        res.status(201).json(outcome);
      })
      .catch(next);
  });

  app.post('/api/sync', (req, res, next) => {
    const body = req.body as { ops?: SyncOp[] };
    store
      .applyOps(body.ops ?? [])
      .then((result) => res.json(result))
      .catch(next);
  });

  return app;
}

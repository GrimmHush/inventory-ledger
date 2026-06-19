import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';
import { InMemoryLedgerStore, type LedgerStore } from './store';
import { itemSchema, movementSchema, syncBodySchema } from './validation';

export interface AppOptions {
  apiKey: string;
  store?: LedgerStore;
}

/**
 * Parses a request body against a schema, replying 400 with the validation
 * issues on failure. Returns the typed value, or `undefined` if it already
 * responded — handlers bail when they get `undefined`.
 */
function parseBody<S extends z.ZodType>(
  schema: S,
  req: Request,
  res: Response,
): z.infer<S> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: 'invalid request body',
      issues: result.error.issues,
    });
    return undefined;
  }
  return result.data;
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
    const item = parseBody(itemSchema, req, res);
    if (!item) return;
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
    const movement = parseBody(movementSchema, req, res);
    if (!movement) return;
    store
      .addMovement(movement)
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
    const body = parseBody(syncBodySchema, req, res);
    if (!body) return;
    store
      .applyOps(body.ops)
      .then((result) => res.json(result))
      .catch(next);
  });

  return app;
}

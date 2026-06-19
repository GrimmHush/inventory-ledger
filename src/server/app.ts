import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';
import { InMemoryLedgerStore, type LedgerStore } from './store';
import { decodeCursor } from './pagination';
import {
  itemCursorSchema,
  itemSchema,
  movementCursorSchema,
  movementSchema,
  paginationQuerySchema,
  syncBodySchema,
} from './validation';

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
 * Parses pagination query params and decodes the cursor against `cursorSchema`,
 * replying 400 on a bad query or cursor. Returns `{ limit, cursor }` or
 * `undefined` if it already responded.
 */
function parsePage<C>(
  cursorSchema: z.ZodType<C>,
  req: Request,
  res: Response,
): { limit: number; cursor: C | null } | undefined {
  const query = paginationQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'invalid query', issues: query.error.issues });
    return undefined;
  }
  let cursor: C | null = null;
  if (query.data.cursor !== undefined) {
    const decoded = cursorSchema.safeParse(decodeCursor(query.data.cursor));
    if (!decoded.success) {
      res.status(400).json({ error: 'invalid cursor' });
      return undefined;
    }
    cursor = decoded.data;
  }
  return { limit: query.data.limit, cursor };
}

/**
 * Builds the Express app. Takes its dependencies as options so tests can inject
 * a fresh store and a known API key — no globals, no singletons.
 */
export function createApp(options: AppOptions): Express {
  const app = express();
  const store = options.store ?? new InMemoryLedgerStore();

  app.use(express.json());

  // Health check sits before auth so probes don't need a key. It pings the
  // backing store (a DB round-trip for Postgres) and reports 503 when the store
  // is unreachable, so a readiness probe fails while the database is down.
  app.get('/health', (_req, res) => {
    store
      .ping()
      .then(() => res.json({ ok: true }))
      .catch(() => res.status(503).json({ ok: false, error: 'store unavailable' }));
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-api-key') !== options.apiKey) {
      res.status(401).json({ error: 'invalid or missing API key' });
      return;
    }
    next();
  });

  app.get('/api/items', (req, res, next) => {
    const page = parsePage(itemCursorSchema, req, res);
    if (!page) return;
    store
      .items(page)
      .then((result) =>
        res.json({ items: result.data, nextCursor: result.nextCursor }),
      )
      .catch(next);
  });

  app.get('/api/items/:id/movements', (req, res, next) => {
    const page = parsePage(movementCursorSchema, req, res);
    if (!page) return;
    store
      .itemMovements(req.params.id, page)
      .then((result) => {
        if (result === null) {
          res.status(404).json({ error: `unknown item ${req.params.id}` });
          return;
        }
        res.json({ movements: result.data, nextCursor: result.nextCursor });
      })
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
      // Return per-op outcomes only — the authoritative result. The full ledger
      // is deliberately not echoed back (it doesn't scale, and the Postgres store
      // only loads the touched slice); clients re-read via the list endpoints.
      .then((result) => res.json({ outcomes: result.outcomes }))
      .catch(next);
  });

  // Terminal error handler. Every async route forwards failures here via
  // `.catch(next)`, so an unexpected error (e.g. a dropped DB connection)
  // returns JSON 500 rather than Express's default HTML page. The four
  // parameters — including the unused `next` — are what mark this as an error
  // handler to Express.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

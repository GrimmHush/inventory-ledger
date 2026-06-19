import { z } from 'zod';
import type { Item, Movement } from '../domain/types';
import type { SyncOp } from '../sync/types';

// Request-body schemas live at the HTTP edge only — the domain and sync layers
// stay free of any validation library. These enforce *structure*; the business
// invariants (positive in/out, non-zero adjust, no overdraw) remain in
// `src/domain/ledger.ts` and `merge`, which run against already-parsed data.

const isoDateTime = z.iso.datetime();

export const itemSchema = z.object({
  id: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const movementSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  type: z.enum(['in', 'out', 'adjust']),
  quantity: z.number().int(),
  reason: z.string().optional(),
  occurredAt: isoDateTime,
});

const syncOpSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('upsertItem'),
    clientSeq: z.number().int(),
    createdAt: isoDateTime,
    item: itemSchema,
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('addMovement'),
    clientSeq: z.number().int(),
    createdAt: isoDateTime,
    movement: movementSchema,
  }),
]);

export const syncBodySchema = z.object({
  ops: z.array(syncOpSchema),
});

// Compile-time guarantee that the schemas stay in lock-step with the domain
// types: if a type gains a field, these lines stop type-checking.
const _itemParity: Item = {} as z.infer<typeof itemSchema>;
const _movementParity: Movement = {} as z.infer<typeof movementSchema>;
const _opParity: SyncOp = {} as z.infer<typeof syncOpSchema>;
void _itemParity;
void _movementParity;
void _opParity;

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OpOutcome } from 'inventory-ledger';
import type { OutboxRecord } from '../src/db';
import { ConflictBanner } from '../src/ui/ConflictBanner';
import { OutboxPanel } from '../src/ui/OutboxPanel';

afterEach(cleanup);

function movementRecord(
  opId: string,
  status: OutboxRecord['status'],
  extra?: Partial<OutboxRecord>,
): OutboxRecord {
  return {
    op: {
      id: opId,
      kind: 'addMovement',
      clientSeq: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      movement: {
        id: `m-${opId}`,
        itemId: 'widget',
        type: 'out',
        quantity: 99,
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    },
    status,
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('ConflictBanner', () => {
  it('shows the rejection reason and discards on click', () => {
    const outcome: OpOutcome = {
      id: 'op1',
      status: 'rejected',
      reason: 'would drive stock of item widget negative',
    };
    const record = movementRecord('op1', 'conflict', { outcome });
    const onDiscard = vi.fn();

    render(<ConflictBanner record={record} onDiscard={onDiscard} />);

    expect(screen.getByText(/would drive stock of item widget negative/)).toBeTruthy();
    expect(screen.getByText('rejected')).toBeTruthy();

    fireEvent.click(screen.getByText('Discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('OutboxPanel', () => {
  it('counts only queued ops and flags a predicted rejection', () => {
    const pending = movementRecord('op-pending', 'pending');
    const conflict = movementRecord('op-conflict', 'conflict', {
      outcome: { id: 'op-conflict', status: 'rejected', reason: 'nope' },
    });
    const predicted: Record<string, OpOutcome['status']> = {
      'op-pending': 'rejected',
    };

    render(<OutboxPanel records={[pending, conflict]} predicted={predicted} />);

    // The header counts queued (non-conflict) ops only.
    expect(screen.getByText('Outbox (1)')).toBeTruthy();
    // The conflict renders its banner reason.
    expect(screen.getByText('nope')).toBeTruthy();
    // A pending op predicted to reject is flagged.
    expect(screen.getByText('will reject')).toBeTruthy();
  });
});

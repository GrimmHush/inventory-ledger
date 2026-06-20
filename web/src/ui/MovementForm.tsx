import { useState, type FormEvent } from 'react';
import type { Movement } from 'inventory-ledger';
import { store } from '../store';
import type { ItemView } from '../optimistic';

export function MovementForm({ items }: { items: ItemView[] }) {
  const [itemId, setItemId] = useState('');
  const [type, setType] = useState<Movement['type']>('in');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');

  const selected = itemId || items[0]?.id || '';

  function submit(e: FormEvent) {
    e.preventDefault();
    const qty = Number(quantity);
    if (!selected || !Number.isFinite(qty)) return;
    void store.addMovement({
      itemId: selected,
      type,
      quantity: qty,
      reason: reason.trim() || undefined,
    });
    setQuantity('1');
    setReason('');
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="eyebrow">Record movement</h2>
      </div>

      {items.length === 0 ? (
        <p className="empty">Add an item first.</p>
      ) : (
        <form className="controls" onSubmit={submit}>
          <select className="field" value={selected} onChange={(e) => setItemId(e.target.value)}>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <select
            className="field type-select"
            value={type}
            onChange={(e) => setType(e.target.value as Movement['type'])}
          >
            <option value="in">in</option>
            <option value="out">out</option>
            <option value="adjust">adjust</option>
          </select>
          <input
            className="field qty"
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Qty"
          />
          <input
            className="field grow"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
          />
          <button className="btn btn-primary" type="submit">
            Record
          </button>
        </form>
      )}
    </section>
  );
}

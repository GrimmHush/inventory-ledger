import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { store } from '../store';
import type { ItemView } from '../optimistic';

export function ItemList({ items }: { items: ItemView[] }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!sku.trim() || !name.trim()) return;
    void store.addItem({ sku: sku.trim(), name: name.trim() });
    setSku('');
    setName('');
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="eyebrow">Items</h2>
        {items.length > 0 && <span className="panel-meta">{items.length} tracked</span>}
      </div>

      {items.length === 0 ? (
        <p className="empty">No items yet. Add one below to start tracking stock.</p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th className="num">On hand</th>
              <th aria-label="open" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="item-row">
                <td className="mono dim">{item.sku}</td>
                <td>
                  <Link to={`/items/${item.id}`} className="item-link">
                    {item.name}
                  </Link>
                </td>
                <td className="num stock">{item.stock}</td>
                <td className="chev" aria-hidden>
                  ›
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="controls" onSubmit={submit}>
        <input
          className="field"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="SKU"
        />
        <input
          className="field grow"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
        />
        <button className="btn" type="submit">
          Add item
        </button>
      </form>
    </section>
  );
}

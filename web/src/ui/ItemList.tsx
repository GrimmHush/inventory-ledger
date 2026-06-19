import { useState } from 'react';
import { store } from '../store';
import type { ItemView } from '../optimistic';

export function ItemList({ items }: { items: ItemView[] }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sku.trim() || !name.trim()) return;
    void store.addItem({ sku: sku.trim(), name: name.trim() });
    setSku('');
    setName('');
  }

  return (
    <section>
      <h2>Items</h2>
      {items.length === 0 ? (
        <p className="muted">No items yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th className="num">Stock</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.sku}</td>
                <td>{item.name}</td>
                <td className="num">{item.stock}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="row" onSubmit={submit}>
        <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <button type="submit">Add item</button>
      </form>
    </section>
  );
}

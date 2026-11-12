// cart: keep what someone means to buy.
//
// New (Tailgate ordered one listing at a time). A cart holds no stock: what's in it can sell out
// before checkout, and `lines()` says so. Checkout is where stock is taken.
//
//   <collection>/<owner>   { <item key>: <qty>, ... }     0 means removed
//
// One field per item, so two devices adding different things both keep theirs (Sync merges by
// field). `left` on a line is `null` for an item with no limit. `owner` is whatever the app knows the buyer by: a session's public name, an account id.
//
// Answers are `{ ok: true, ... }` or `{ error: <code>, ... }`. The app chooses the words.

export function createCart({ store, catalog, collection = 'carts', max = 99 } = {}) {
  if (!store || !catalog) throw new TypeError('createCart needs a store and a catalog');

  const counts = (owner) =>
    Object.entries(store.get(collection, owner) ?? {}).filter(([, qty]) => Number.isInteger(qty) && qty > 0);

  async function set(owner, item, qty) {
    if (!owner) return { error: 'no-owner' };
    if (!Number.isInteger(qty) || qty < 0) return { error: 'bad-qty' };
    if (qty > max) return { error: 'too-many', max };
    if (qty > 0) {
      const found = catalog.item(item);
      if (!found) return { error: 'gone', item };
      if (found.left !== null && found.left < qty) return { error: 'sold-out', item, left: found.left };
    }
    await store.write(collection, owner, { [item]: qty });
    return { ok: true, item, qty };
  }

  return {
    /** Set a line's quantity; 0 removes it. */
    set,
    /** Add `qty` to a line. */
    add: (owner, item, qty = 1) =>
      Number.isInteger(qty) && qty > 0 ? set(owner, item, (store.get(collection, owner)?.[item] ?? 0) + qty) : Promise.resolve({ error: 'bad-qty' }),
    /** Remove a line. */
    remove: (owner, item) => set(owner, item, 0),

    /**
     * Take `lines` out of the cart (what was just bought). A line added since, or a quantity
     * raised since, keeps the difference.
     */
    async clear(owner, lines) {
      const now = store.get(collection, owner) ?? {};
      const fields = {};
      for (const [item, qty] of lines ? lines.map((line) => [line.item, line.qty]) : counts(owner)) fields[item] = Math.max(0, (now[item] ?? 0) - qty);
      if (Object.keys(fields).length) await store.write(collection, owner, fields);
      return { ok: true };
    },

    /**
     * The cart as the buyer sees it: each line priced now, its total, and `short` when fewer are
     * left than it asks for (`gone` when the item isn't for sale any more). `cents` totals the
     * lines that can be bought; `ready` is false when any line can't.
     */
    view(owner, context = {}) {
      const lines = counts(owner)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([item, qty]) => {
          const found = catalog.item(item, context);
          if (!found) return { item, qty, gone: true, cents: 0, total: 0 };
          return { item, qty, name: found.name, unit: found.unit, cents: found.cents, total: found.cents * qty, left: found.left, short: found.left !== null && found.left < qty };
        });
      const ok = lines.filter((line) => !line.gone && !line.short);
      return {
        lines,
        count: lines.reduce((sum, line) => sum + line.qty, 0),
        cents: ok.reduce((sum, line) => sum + line.total, 0),
        ready: lines.length > 0 && ok.length === lines.length,
      };
    },
  };
}

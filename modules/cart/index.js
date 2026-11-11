// cart: keep what someone means to buy.
//
// New. One document per holder (a signed-in person, or a guest's id), so a cart follows its
// owner from phone to laptop through the store, and the server can read it at checkout:
//
//   <collection>/<holder>   { lines: [{ item, qty }] }
//
// A cart never holds stock back; `catalog.take` does that at checkout. It does refuse what can't
// be had right now (`gone`, `short`), and `view` says what has changed since a line was added:
// an item gone, or fewer left than the line wants.
//
// Prices come from the catalog when the cart is read, never from the cart, so a price changed
// since the line was added is the price paid. `priceOf(item, context)` adjusts it (the `price`
// module's rules, a member discount); by default it's the item's own `cents`.

export function createCart({ store, catalog, collection = 'carts', maxQty = 100, priceOf = (item) => item.cents } = {}) {
  if (!store || !catalog) throw new TypeError('createCart needs a store and a catalog');

  const linesOf = (holder) => (store.get(collection, holder)?.lines ?? []).filter((line) => line && typeof line.item === 'string' && Number.isInteger(line.qty) && line.qty > 0);
  const save = (holder, lines) => store.write(collection, holder, { lines });
  const check = (holder, item, qty) => {
    if (!holder) return { error: 'no-holder' };
    if (!Number.isInteger(qty) || qty < 0 || qty > maxQty) return { error: 'bad-qty', max: maxQty };
    const left = catalog.left(item);
    if (qty > 0 && left === 0) return { error: 'gone', item };
    if (qty > left) return { error: 'short', item, left };
    return null;
  };

  /** Set a line to `qty` (0 takes it out). */
  async function set(holder, item, qty) {
    const refused = check(holder, item, qty);
    if (refused) return refused;
    const lines = linesOf(holder).filter((line) => line.item !== item);
    const at = linesOf(holder).findIndex((line) => line.item === item);
    if (qty > 0) lines.splice(at < 0 ? lines.length : at, 0, { item, qty });
    await save(holder, lines);
    return { ok: true, qty };
  }

  return {
    set,

    /** Add `qty` more of an item (1 by default). */
    add(holder, item, qty = 1) {
      if (!Number.isInteger(qty) || qty < 1) return Promise.resolve({ error: 'bad-qty', max: maxQty });
      const had = linesOf(holder).find((line) => line.item === item)?.qty ?? 0;
      return set(holder, item, had + qty);
    },

    remove: (holder, item) => set(holder, item, 0),

    async clear(holder) {
      if (!holder) return { error: 'no-holder' };
      await save(holder, []);
      return { ok: true };
    },

    /** The lines as stored: [{ item, qty }]. */
    lines: linesOf,

    /**
     * The cart as it stands now: each line with its item's name, unit and price, and a `problem`
     * (`gone` or `short`, with `left`) when it can't be had as it is; the subtotal of the lines
     * that can be; how many things in all; and `ok`, whether it can be checked out as it is.
     */
    view(holder, context = {}) {
      const lines = linesOf(holder).map(({ item: key, qty }) => {
        const item = catalog.get(key);
        const left = catalog.left(key);
        const line = { item: key, qty, name: item?.name ?? '', unit: item?.unit ?? '', left };
        if (left === 0) return { ...line, each: 0, cents: 0, problem: 'gone' };
        const each = priceOf(item, context);
        return { ...line, each, cents: each * qty, ...(qty > left && { problem: 'short' }) };
      });
      return {
        lines,
        cents: lines.filter((line) => !line.problem).reduce((sum, line) => sum + line.cents, 0),
        count: lines.reduce((sum, line) => sum + line.qty, 0),
        ok: lines.length > 0 && lines.every((line) => !line.problem),
      };
    },
  };
}

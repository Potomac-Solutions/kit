// catalog: say what's for sale and how many are left.
//
// Taken from Tailgate's market (src/market.js, 3ec2c31): its listings, the "what a customer can
// buy now" filter, and the stock check and decrement in placeOrder, with the farm taken out. An
// item's key may start with a section (`hilltop/eggs`, `kitchen/pie`) so one catalog can hold
// several sellers or departments, and `list('hilltop/')` reads one.
//
//   <collection>/<key>   { name, unit, cents, qty, active, ...the app's own fields }
//
// `qty` is how many are left: a whole number, or null for no limit (a service, a download).
// `active: false` hides an item without losing it. Money is whole cents.
//
// `take(lines)` is the one write that matters: every line's stock is checked, then every
// decrement is written, with nothing awaited in between, so two buyers can't both get the last
// one and a cart is never half taken.

const KEY = /^[\w-]{1,64}(\/[\w-]{1,64})?$/;

export function createCatalog({ store, collection = 'items' } = {}) {
  if (!store) throw new TypeError('createCatalog needs a store');

  const read = (key) => {
    const fields = store.get(collection, key);
    return fields ? { key, ...fields } : null;
  };
  const forSale = (item) =>
    Boolean(item) && item.active !== false && String(item.name ?? '').trim() !== '' && Number.isInteger(item.cents) && item.cents > 0;
  const leftOf = (item) => (item.qty === null || item.qty === undefined ? Infinity : item.qty);
  /** The lines as item → total qty, or an error for a malformed or empty list. */
  const merged = (lines) => {
    const wanted = new Map();
    for (const { item, qty } of lines ?? []) {
      if (!Number.isInteger(qty) || qty < 1) return { error: 'bad-qty', item };
      wanted.set(item, (wanted.get(item) ?? 0) + qty);
    }
    return wanted.size ? wanted : { error: 'empty' };
  };

  const catalog = {
    /** One item as stored, or null. */
    get: read,

    /** Add or change an item. Only the fields given change. */
    async put(key, fields = {}) {
      if (!KEY.test(String(key))) return { error: 'bad-key' };
      if ('name' in fields && (typeof fields.name !== 'string' || !fields.name.trim())) return { error: 'bad-name' };
      if ('cents' in fields && (!Number.isInteger(fields.cents) || fields.cents < 0)) return { error: 'bad-price' };
      if ('qty' in fields && fields.qty !== null && (!Number.isInteger(fields.qty) || fields.qty < 0)) return { error: 'bad-qty' };
      if (!read(key) && !('name' in fields && 'cents' in fields)) return { error: 'incomplete' };
      await store.write(collection, key, fields);
      return { ok: true };
    },

    /** What can be bought now under `prefix`: active, named, priced and in stock, in key order. */
    list(prefix = '', { soldOut = false } = {}) {
      return store
        .under(collection, prefix)
        .filter((item) => forSale(item) && (soldOut || leftOf(item) > 0));
    },

    /** How many are left (Infinity for no limit); 0 for an item that isn't for sale. */
    left(key) {
      const item = read(key);
      return forSale(item) ? leftOf(item) : 0;
    },

    /**
     * Whether `lines` ([{ item, qty }]) can all be had now: null, or the first line that can't,
     * as `{ error: 'gone', item }` (not for sale, or none left) or `{ error: 'short', item, left }`.
     * Synchronous, so a caller can check, then write, with nothing in between.
     */
    check(lines) {
      const wanted = merged(lines);
      if (wanted.error) return wanted;
      for (const [key, qty] of wanted) {
        const item = read(key);
        if (!forSale(item) || leftOf(item) === 0) return { error: 'gone', item: key };
        if (leftOf(item) < qty) return { error: 'short', item: key, left: leftOf(item) };
      }
      return null;
    },

    /**
     * Take `lines` out of stock, all or nothing: checked, then every decrement written before
     * anything is awaited. Answers as `check` does when it can't.
     */
    take(lines) {
      const refused = catalog.check(lines);
      if (refused) return Promise.resolve(refused);
      const writes = [];
      for (const [key, qty] of merged(lines)) {
        const item = read(key);
        if (leftOf(item) !== Infinity) writes.push(store.write(collection, key, { qty: item.qty - qty }));
      }
      return Promise.all(writes).then(() => ({ ok: true }));
    },

    /** Put `lines` back (a payment that failed, an order cancelled). */
    give(lines) {
      const writes = [];
      for (const { item: key, qty } of lines ?? []) {
        const item = read(key);
        if (item && Number.isInteger(qty) && qty > 0 && leftOf(item) !== Infinity) writes.push(store.write(collection, key, { qty: item.qty + qty }));
      }
      return Promise.all(writes).then(() => ({ ok: true }));
    },
  };
  return catalog;
}

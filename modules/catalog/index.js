// catalog: say what's for sale and how many are left.
//
// Taken from Tailgate's market (src/market.js, fc0f6ae: `catalog()` and the stock check in
// `placeOrder`), with the farms taken out. An *item* is one thing someone can buy (a dozen eggs, a
// day pass, a mount). Its key can carry who sells it (`hillside/eggs`), so `items('hillside/')`
// is one seller's shelf.
//
//   <collection>/<key>   { name, unit, cents, <left>, ...the app's own fields }
//
// Prices come from `price`: an item's `cents` is the base, and the catalog's rules run over it
// with the context the app passes (a time, a member flag) plus `item` (the key) and the item's
// `tags`, if it has any.
//
// `take` is what checkout uses: every line is checked, then every line is written, with no
// `await` between, so two buyers can't both get the last one. It is all or nothing.
//
// Answers are `{ ok: true, ... }` or `{ error: <code>, ... }`. The app chooses the words.

import { price as priceOf } from '../price/index.js';

const DEFAULT_READ = (doc, left) => ({
  name: typeof doc.name === 'string' ? doc.name.trim() : '',
  unit: typeof doc.unit === 'string' && doc.unit.trim() ? doc.unit.trim() : 'each',
  cents: doc.cents,
  left: doc[left],
});

export function createCatalog({
  store,
  collection = 'items',
  // The field that counts what's left. Tailgate's is `qty`.
  left = 'left',
  // Turn a stored document into { name, unit, cents, left }. For an app that stores a price as
  // dollars, or a name somewhere else. `left` must still be the field named above.
  read = (doc) => DEFAULT_READ(doc, left),
  // Whether a stored item is on sale at all (Tailgate: on its farm's list). Default: all are.
  listed = () => true,
  rules = [],
} = {}) {
  if (!store) throw new TypeError('createCatalog needs a store');

  /** An item as a buyer sees it, or null if it isn't for sale (unnamed, unpriced, unlisted). */
  function view(key, doc, context) {
    if (!doc || !listed(key, doc)) return null;
    const { name, unit, cents, left: count } = read(doc);
    if (!name || !Number.isInteger(cents) || cents <= 0) return null;
    const { cents: now, applied } = priceOf(cents, rules, { ...context, ...(doc.tags ?? {}), item: key });
    return { key, name, unit, base: cents, cents: now, applied, left: Math.max(0, Math.floor(Number(count) || 0)) };
  }

  const stocked = (item) => item && item.left > 0;

  return {
    /** One item, sold out or not, or null if it isn't for sale. */
    item: (key, context = {}) => view(key, store.get(collection, key), context),

    /** What's for sale now under a key prefix: in stock, in key order. `{ all: true }` keeps sold-out items. */
    items(prefix = '', context = {}, { all = false } = {}) {
      return store
        .under(collection, prefix)
        .map(({ key, ...doc }) => view(key, doc, context))
        .filter((item) => item && (all || stocked(item)));
    },

    /**
     * Take stock for `lines` ([{ item, qty }]), all or nothing. Stored before it returns; the
     * promise is the broadcast. `{ error: 'sold-out', item, left }` names the first line short.
     */
    take(lines) {
      const want = new Map();
      for (const line of lines ?? []) {
        if (!Number.isInteger(line?.qty) || line.qty < 1) return { error: 'bad-qty', item: line?.item };
        want.set(line.item, (want.get(line.item) ?? 0) + line.qty);
      }
      if (!want.size) return { error: 'empty' };
      const after = [];
      for (const [key, qty] of want) {
        const item = view(key, store.get(collection, key), {});
        if (!item) return { error: 'gone', item: key };
        if (item.left < qty) return { error: 'sold-out', item: key, left: item.left };
        after.push([key, item.left - qty]);
      }
      const sent = after.map(([key, count]) => store.write(collection, key, { [left]: count }));
      return { ok: true, sent: Promise.all(sent) };
    },

    /** Put stock back (a payment that failed). Not checked against anything: it only adds. */
    restock(lines) {
      const sent = [];
      for (const { item: key, qty } of lines ?? []) {
        const doc = store.get(collection, key);
        if (!doc || !Number.isInteger(qty) || qty < 1) continue;
        sent.push(store.write(collection, key, { [left]: Math.max(0, Math.floor(Number(doc[left]) || 0)) + qty }));
      }
      return Promise.all(sent);
    },
  };
}

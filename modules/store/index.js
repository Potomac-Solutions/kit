// The seam between the kit and wherever an app keeps its documents.
//
// The kit owns no storage. A module is handed a store, three functions:
//
//   get(collection, key)             one document's fields, or null            (synchronous)
//   under(collection, prefix = '')   [{ key, ...fields }] whose key starts so  (synchronous)
//   write(collection, key, fields)   merge fields into a document; returns a promise
//
// The one rule that matters: `write` has stored its fields by the time it returns. The promise
// is only the broadcast to other devices. Because `get` and `under` are synchronous too, a module
// can check and then write with no `await` between, and two requests can't interleave. Every
// "exactly one wins" in the kit rests on that.
//
// In a Zubra app the store is the Sync log read on the server (CineStack's `fieldLog` plus its
// server `write`, or `sync.documents()` / `sync.write()` once those are released). `memoryStore`
// is for tests and for apps with nothing to sync.

export function memoryStore() {
  const collections = new Map();
  const of = (collection) => collections.get(collection) ?? collections.set(collection, new Map()).get(collection);
  return {
    get: (collection, key) => {
      const doc = of(collection).get(key);
      return doc ? { ...doc } : null;
    },
    under: (collection, prefix = '') =>
      [...of(collection)]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, fields]) => ({ key, ...fields })),
    write(collection, key, fields) {
      of(collection).set(key, { ...of(collection).get(key), ...fields });
      return Promise.resolve();
    },
  };
}

/**
 * Check that a store keeps the contract. An app runs this against its own store in a test, with
 * `assert` from `node:assert/strict`. Uses a collection name nothing else would.
 */
export async function checkStore(store, assert, collection = 'kit-store-check') {
  assert.equal(store.get(collection, 'a/1'), null, 'a missing document is null');
  const sent = store.write(collection, 'a/1', { n: 1, tag: 'x' });
  assert.deepEqual(store.get(collection, 'a/1'), { n: 1, tag: 'x' }, 'a write is stored before its promise settles');
  await sent;
  await store.write(collection, 'a/1', { n: 2 });
  assert.deepEqual(store.get(collection, 'a/1'), { n: 2, tag: 'x' }, 'a write merges fields');
  await store.write(collection, 'a/2', { n: 3 });
  await store.write(collection, 'b/1', { n: 4, nested: { list: [1, null] } });
  assert.deepEqual(store.under(collection, 'a/').map((doc) => doc.key), ['a/1', 'a/2'], 'under() filters by prefix, in key order');
  assert.equal(store.under(collection).length, 3, 'under() with no prefix is the whole collection');
  assert.deepEqual(store.get(collection, 'b/1').nested, { list: [1, null] }, 'values round-trip');
}

/**
 * The collections the kit's modules write by default. Every rule in them (one winner, charged
 * once, stock never below zero, the price from the catalog) assumes only the server writes them.
 * Add the names you changed or chose yourself: the `stages` collection (`orders`, `rentals`),
 * hold's `names`, a module's `collection`.
 */
export const SERVER_ONLY = Object.freeze(['items', 'carts', 'checkouts', 'payments', 'bookings', 'units', 'holds']);

/**
 * An `authorize` for `createSyncServer` that refuses a page's changes to the kit's collections.
 * Pages still read them (scoped as you scope them); only the server, through `syncStore`, writes.
 * Everything else goes to `next`, your own rule for your own collections.
 *
 *   createSyncServer({ authorize: serverOnly([...SERVER_ONLY, 'orders'], myAuthorize) })
 *
 * Use it wherever the kit runs on Sync: Sync lets pages write anything by default.
 */
export function serverOnly(collections = SERVER_ONLY, next = () => true) {
  const only = new Set(collections);
  return (asked) => (asked.kind === 'change' && only.has(asked.collection) ? false : next(asked));
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The store over a Zubra Sync server (`createSyncServer` from `@zubra/sync/server`, 5.8 or later),
 * or over a `ZubraSync` Durable Object from inside it. What the kit writes goes into the log and out
 * to every open page. The kit imports nothing from Zubra; it is handed the server.
 *
 *   const store = await syncStore(sync);
 */
export async function syncStore(sync) {
  if (typeof sync?.documents !== 'function' || typeof sync.write !== 'function') throw new TypeError('syncStore needs a Sync server with documents() and write() (@zubra/sync 5.8 or later)');
  const docs = await sync.documents();
  return {
    get: (collection, key) => docs.get(collection, key) ?? null,
    // The prefix is also checked here, so 5.6 and 5.7 (whose all() took no prefix) work too.
    under: (collection, prefix = '') => docs.all(collection, prefix).filter((doc) => doc.key.startsWith(prefix)).sort(byKey),
    write: (collection, key, fields) => sync.write(collection, key, fields),
  };
}

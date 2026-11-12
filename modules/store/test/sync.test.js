// The kit over a real Zubra Sync server (@zubra/sync 5.8): the store keeps the contract, and a
// whole checkout runs on it, with what it writes reaching the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, memoryLog } from '@zubra/sync/server';
import { syncStore, checkStore, serverOnly, SERVER_ONLY } from '../index.js';
import { market } from '../../checkout/test/market.js';

test('syncStore keeps the store contract', async () => {
  const sync = createSyncServer({ log: memoryLog() });
  await checkStore(await syncStore(sync), assert);
});

test('syncStore lists in key order, not the order written', async () => {
  const store = await syncStore(createSyncServer({ log: memoryLog() }));
  await store.write('items', 'x/2', { n: 2 });
  await store.write('items', 'x/10', { n: 10 });
  await store.write('items', 'x/1', { n: 1 });
  await store.write('items', 'y/1', { n: 0 });
  assert.deepEqual(store.under('items', 'x/').map((doc) => doc.key), ['x/1', 'x/10', 'x/2']);
});

test('syncStore refuses something that is not a Sync server', async () => {
  await assert.rejects(syncStore({}), /documents\(\) and write\(\)/);
});

test('a checkout over Sync: one winner of the last dozen, and the orders are in the log', async () => {
  const log = memoryLog();
  const sync = createSyncServer({ log });
  const { cart, checkout, charges } = await market({ store: await syncStore(sync), stock: { eggs: 1, beef: 5 } });
  await cart.set('ada', 'hill/eggs', 1);
  await cart.set('bo', 'hill/eggs', 1);
  const [ada, bo] = await Promise.all([checkout.place('ada', { key: 'a', method: { card: '4242' } }), checkout.place('bo', { key: 'b', method: { card: '4242' } })]);
  assert.equal(ada.ok, true);
  assert.equal(bo.error, 'not-ready');
  assert.equal(charges.length, 1);
  const { changes } = await log.after(0, 1000);
  const fields = (collection, key) => Object.fromEntries(changes.filter((c) => c.collection === collection && c.key === key).map((c) => [c.field, c.value]));
  assert.equal(fields('orders', 'a/hill').status, 'placed');
  assert.equal(fields('items', 'hill/eggs').left, 0);
  assert.equal(fields('checkouts', 'a').state, 'paid');
  // A fresh server reading the same log sees what this one wrote.
  const again = await syncStore(createSyncServer({ log }));
  assert.equal(again.get('orders', 'a/hill').owner, 'ada');
});

test('a weekend booking over Sync: all or nothing, confirmed in the log', async () => {
  const { createHolds } = await import('../../hold/index.js');
  const { createPay, testProvider } = await import('../../pay/index.js');
  const { createStages } = await import('../../stages/index.js');
  const { createReserve } = await import('../../reserve/index.js');
  const log = memoryLog();
  const store = await syncStore(createSyncServer({ log }));
  const holds = createHolds({ store });
  const reserve = createReserve({ store, holds, pay: createPay({ provider: testProvider(), store }), stages: createStages({ store, collection: 'rentals', steps: ['booked', 'out', 'returned'], stamp: false }), base: 4000 });
  const days = ['kayaks/2026-11-20', 'kayaks/2026-11-21', 'kayaks/2026-11-22'];
  const [ada, bo] = await Promise.all([reserve.hold('ada', { key: 'a', pools: days, count: 1, from: ['k1'] }), reserve.hold('bo', { key: 'b', pools: days.slice(2), count: 1, from: ['k1'] })]);
  assert.equal(ada.ok, true);
  assert.deepEqual(bo, { error: 'none-free', left: 0 });
  assert.equal((await reserve.book('ada', 'a', { method: { card: '4242' } })).ok, true);
  const again = await syncStore(createSyncServer({ log }));
  for (const day of days) assert.equal(again.get('units', `${day}/k1`).state, 'taken');
  assert.equal(again.get('rentals', 'a').status, 'booked');
});

test("serverOnly: a page can't push to the kit's collections, the server still writes them", async () => {
  const sync = createSyncServer({ log: memoryLog(), authorize: serverOnly([...SERVER_ONLY, 'orders']) });
  const store = await syncStore(sync);
  const clock = () => `${String(Date.now() + 1).padStart(15, '0')}-00000-page`;
  const push = (collection) =>
    sync.fetch(new Request('http://shop.example/_zb/sync/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ collection, key: 'a', field: 'x', value: 1, clock: clock() }] }) })).then((r) => r.status);
  for (const collection of [...SERVER_ONLY, 'orders']) assert.equal(await push(collection), 403, collection);
  assert.equal(await push('notes'), 200, 'other collections go to next');
  await store.write('items', 'hill/eggs', { cents: 600 });
  assert.equal(store.get('items', 'hill/eggs').cents, 600);
  const strict = serverOnly(SERVER_ONLY, () => false);
  assert.equal(strict({ kind: 'change', collection: 'notes' }), false, 'next decides the rest');
  assert.equal(serverOnly()({ kind: 'read', collection: 'items' }), true, 'pages still read');
});

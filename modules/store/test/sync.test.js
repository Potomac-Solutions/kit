// The kit over a real Zubra Sync server (@zubra/sync 5.8): the store keeps the contract, and a
// whole checkout runs on it, with what it writes reaching the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, memoryLog } from '@zubra/sync/server';
import { syncStore, checkStore } from '../index.js';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../../catalog/index.js';
import { createCart } from '../../cart/index.js';
import { createPay, testProvider, FAILING_CARD } from '../../pay/index.js';
import { createStages } from '../../stages/index.js';
import { createNotify, outbox } from '../../notify/index.js';
import { createCheckout } from '../index.js';
import { market } from './market.js';

const CARD = { card: '4242 4242 4242 4242' };

test('a cart from two farms is paid once and becomes one order per farm', async () => {
  const { store, cart, checkout, charges, mail } = await market();
  await cart.set('ada', 'hill/eggs', 2);
  await cart.set('ada', 'vale/beef', 1);
  const done = await checkout.place('ada', { key: 'c1', method: CARD, fields: { address: '1 Main St' }, contact: { email: 'ada@example.com' } });
  assert.deepEqual(done, { ok: true, key: 'c1', orders: ['c1/hill', 'c1/vale'], ref: 'test_1', cents: 1200 + 899 + 800, notified: true });
  assert.equal(charges.length, 1);
  assert.equal(charges[0].cents, 2899);
  assert.deepEqual(store.get('orders', 'c1/hill'), {
    address: '1 Main St',
    checkout: 'c1',
    owner: 'ada',
    group: 'hill',
    lines: [{ item: 'hill/eggs', qty: 2, name: 'Eggs', unit: 'dozen', cents: 600, total: 1200 }],
    cents: 1200,
    fee: 400,
    status: 'placed',
    placed: 7,
  });
  assert.equal(store.get('orders', 'c1/vale').cents, 899);
  assert.equal(store.get('items', 'hill/eggs').left, 3);
  assert.equal(store.get('checkouts', 'c1').state, 'paid');
  assert.equal(cart.view('ada').count, 0, 'the cart is empty');
  assert.equal(mail.sent.length, 1);
  assert.equal(JSON.stringify(store.under('checkouts')).includes('4242'), false, 'the card is never stored');
});

test('without groups, one order under the checkout key; a fee with no group goes on it', async () => {
  const store = memoryStore();
  await store.write('items', 'a', { name: 'A', cents: 100, left: 9 });
  await store.write('items', 'b', { name: 'B', cents: 200, left: 9 });
  const catalog = createCatalog({ store });
  const cart = createCart({ store, catalog });
  const checkout = createCheckout({
    store,
    catalog,
    cart,
    pay: createPay({ provider: testProvider(), store }),
    stages: createStages({ store, collection: 'orders', steps: ['placed', 'ready'], stamp: false }),
    fees: () => [{ label: 'Booking', cents: 50 }],
  });
  await cart.set('u', 'a', 1);
  await cart.set('u', 'b', 1);
  const done = await checkout.place('u', { key: 'k' });
  assert.deepEqual(done.orders, ['k']);
  assert.equal(done.cents, 350);
  assert.equal(store.get('orders', 'k').fee, 50);
  assert.equal(done.notified, undefined, 'no notify, no answer about it');
});

test('a double press is one checkout and one charge', async () => {
  const { checkout, cart, charges, store } = await market();
  await cart.set('ada', 'hill/eggs', 1);
  const [first, second] = await Promise.all([checkout.place('ada', { key: 'c1', method: CARD }), checkout.place('ada', { key: 'c1', method: CARD })]);
  assert.equal(first.ok, true);
  assert.deepEqual(second, { error: 'in-progress' });
  assert.deepEqual(await checkout.place('ada', { key: 'c1', method: CARD }), { ok: true, again: true, key: 'c1', orders: ['c1/hill'], ref: 'test_1' });
  assert.equal(charges.length, 1);
  assert.equal(store.get('items', 'hill/eggs').left, 4, 'stock taken once');
});

test('many buyers, five dozen eggs: only as many win as there are eggs, and each pays once', async () => {
  const { checkout, cart, charges, store } = await market();
  const buyers = Array.from({ length: 12 }, (_, i) => `b${i}`);
  for (const who of buyers) await cart.set(who, 'hill/eggs', 1);
  await store.write('items', 'hill/eggs', { left: 5 });
  const results = await Promise.all(buyers.map((who) => checkout.place(who, { key: `k-${who}`, method: CARD })));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.deepEqual([...new Set(results.filter((r) => !r.ok).map((r) => r.error))], ['not-ready']);
  assert.equal(charges.length, 5);
  assert.equal(store.get('items', 'hill/eggs').left, 0);
  assert.equal(store.under('orders').length, 5);
});

test('a declined card puts the stock back, keeps the cart, and can be tried again', async () => {
  const { checkout, cart, store, charges } = await market();
  await cart.set('ada', 'hill/eggs', 5);
  assert.deepEqual(await checkout.place('ada', { key: 'c1', method: { card: FAILING_CARD } }), { error: 'declined', key: 'c1' });
  assert.equal(store.get('items', 'hill/eggs').left, 5, 'stock back');
  assert.equal(cart.view('ada').count, 5, 'cart kept');
  assert.equal(store.get('checkouts', 'c1').state, 'failed');
  assert.equal(store.under('orders').length, 0, 'no order');
  const again = await checkout.place('ada', { key: 'c1', method: CARD });
  assert.equal(again.ok, true);
  assert.equal(charges.length, 2);
  assert.equal(store.get('items', 'hill/eggs').left, 0);
});

test('while a checkout waits on the provider, nobody else can buy its stock', async () => {
  let release;
  const slow = { charge: () => new Promise((resolve) => (release = () => resolve({ ok: true, ref: 'slow' }))) };
  const { checkout, cart } = await market({ provider: slow, stock: { eggs: 1, beef: 0 } });
  await cart.set('ada', 'hill/eggs', 1);
  await cart.set('bo', 'hill/eggs', 1);
  const ada = checkout.place('ada', { key: 'a', method: CARD });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await checkout.place('bo', { key: 'b', method: CARD }), { error: 'not-ready', lines: [{ item: 'hill/eggs', qty: 1, name: 'Eggs', unit: 'dozen', cents: 600, total: 600, left: 0, short: true }] });
  release();
  assert.equal((await ada).ok, true);
});

test('refusals: empty, not ready, someone elses checkout, no owner', async () => {
  const { checkout, cart, store } = await market();
  assert.deepEqual(await checkout.place('ada', { key: 'c1' }), { error: 'empty' });
  await cart.set('ada', 'hill/eggs', 3);
  await store.write('items', 'hill/eggs', { left: 2 });
  assert.equal((await checkout.place('ada', { key: 'c1' })).error, 'not-ready');
  await store.write('items', 'hill/eggs', { left: 5 });
  await checkout.place('ada', { key: 'c1', method: CARD });
  assert.deepEqual(await checkout.place('bo', { key: 'c1' }), { error: 'not-yours' });
  assert.deepEqual(await checkout.place(''), { error: 'no-owner' });
});

test('a notify that throws does not undo a paid order', async () => {
  const { store, catalog, cart, pay, stages } = await market();
  const checkout = createCheckout({ store, catalog, cart, pay, stages, notify: { notify: async () => { throw new Error('smtp down'); } } });
  await cart.set('ada', 'hill/eggs', 1);
  const done = await checkout.place('ada', { key: 'c1', method: CARD, contact: { email: 'a@b.example' } });
  assert.equal(done.ok, true);
  assert.equal(done.notified, false);
});

test('a fee with no group goes on the first order, not every order', async () => {
  const { store, catalog, cart, pay, stages } = await market();
  const checkout = createCheckout({ store, catalog, cart, pay, stages, group: (line) => line.item.split('/')[0], fees: () => [{ label: 'Service', cents: 99 }] });
  await cart.set('ada', 'hill/eggs', 1);
  await cart.set('ada', 'vale/beef', 1);
  const done = await checkout.place('ada', { key: 'c1', method: CARD });
  assert.equal(done.cents, 600 + 899 + 99);
  assert.deepEqual(done.orders.map((key) => store.get('orders', key).fee), [99, 0]);
});

test('quote says what checking out would charge, per order, and writes nothing', async () => {
  const { store, catalog, cart, pay, stages } = await market();
  const checkout = createCheckout({
    store, catalog, cart, pay, stages,
    group: (line) => line.item.split('/')[0],
    fees: ({ lines, fields }) => (fields.pickup ? [] : [...new Set(lines.map((line) => line.item.split('/')[0]))].map((farm) => ({ label: 'Delivery', cents: 400, group: farm }))),
  });
  await cart.set('ada', 'hill/eggs', 2);
  await cart.set('ada', 'vale/beef', 1);
  const before = JSON.stringify(store.under('items')) + JSON.stringify(store.under('checkouts'));
  const quoted = checkout.quote('ada');
  assert.equal(quoted.ready, true);
  assert.deepEqual(quoted.orders.map(({ group, cents, fee, total }) => ({ group, cents, fee, total })), [
    { group: 'hill', cents: 1200, fee: 400, total: 1600 },
    { group: 'vale', cents: 899, fee: 400, total: 1299 },
  ]);
  assert.equal(quoted.cents, 2899);
  assert.equal(checkout.quote('ada', { fields: { pickup: true } }).cents, 2099, 'a fee can depend on the fields');
  assert.equal(JSON.stringify(store.under('items')) + JSON.stringify(store.under('checkouts')), before, 'nothing written');
  const done = await checkout.place('ada', { key: 'c1', method: CARD, fields: { pickup: true } });
  assert.equal(done.cents, 2099, 'place charges what quote said');
  assert.equal(store.get('orders', 'c1/hill').fee, 0);
});

test('a checkout of something with no limit leaves it with no limit', async () => {
  const { store, cart, checkout } = await market();
  await store.write('items', 'vale/tour', { name: 'Farm tour', cents: 2500, left: null });
  await cart.set('ada', 'vale/tour', 4);
  assert.equal((await checkout.place('ada', { key: 'c1', method: CARD })).ok, true);
  assert.equal(store.get('items', 'vale/tour').left, null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../../catalog/index.js';
import { createCart } from '../../cart/index.js';
import { createPay, testProvider, FAILING_CARD } from '../../pay/index.js';
import { createStages } from '../../stages/index.js';
import { createCheckout } from '../index.js';

const CARD = { card: '4242424242424242' };

/** A provider that answers when the test says, to look inside a payment while it's out. */
function heldProvider() {
  const waiting = [];
  return {
    calls: 0,
    charge() {
      this.calls++;
      return new Promise((answer) => waiting.push(answer));
    },
    /** Answer the next charge, once it has been asked for. */
    async answer(result) {
      while (!waiting.length) await new Promise((next) => setImmediate(next));
      waiting.shift()(result);
    },
  };
}

async function setup({ provider = testProvider(), ...options } = {}) {
  const store = memoryStore();
  const catalog = createCatalog({ store });
  await catalog.put('hilltop/eggs', { name: 'Pasture eggs', unit: 'dozen', cents: 600, qty: 18 });
  await catalog.put('hilltop/greens', { name: 'Salad greens', unit: 'bag', cents: 500, qty: 1 });
  await catalog.put('meadow/honey', { name: 'Wildflower honey', unit: 'jar', cents: 1100, qty: 14 });
  const cart = createCart({ store, catalog });
  const pay = createPay({ provider, store });
  const stages = createStages({ store, collection: 'orders', steps: ['placed', 'claimed', 'picked', 'delivered'], owner: 'driver' });
  let n = 0;
  const checkout = createCheckout({ catalog, cart, pay, stages, id: () => `c${++n}`, ...options });
  return { store, catalog, cart, pay, stages, checkout, provider };
}

const byFarm = { group: (item) => item.split('/')[0], extras: () => [{ label: 'Delivery', cents: 600 }] };

test('a cart from two farms: one payment, one order per farm, stock taken, cart emptied', async () => {
  const { checkout, cart, catalog, store, pay } = await setup(byFarm);
  await cart.add('rosa', 'hilltop/eggs', 2);
  await cart.add('rosa', 'meadow/honey');
  await cart.add('rosa', 'hilltop/greens');
  const quote = checkout.quote('rosa');
  assert.equal(quote.total, 1200 + 500 + 600 + 1100 + 600);
  const done = await checkout.checkout('rosa', { details: { address: '12 Main St' }, method: CARD });
  assert.deepEqual(done, { ok: true, id: 'c1', orders: ['c1-hilltop', 'c1-meadow'], total: quote.total });
  assert.equal(pay.paid('c1').cents, quote.total);
  assert.equal(pay.paid('c1').state, 'paid');
  const hilltop = store.get('orders', 'c1-hilltop');
  assert.equal(hilltop.status, 'placed');
  assert.equal(hilltop.address, '12 Main St');
  assert.equal(hilltop.holder, 'rosa');
  assert.equal(hilltop.payment, 'c1');
  assert.deepEqual(hilltop.lines.map((line) => [line.item, line.qty, line.each, line.cents]), [['hilltop/eggs', 2, 600, 1200], ['hilltop/greens', 1, 500, 500]]);
  assert.deepEqual([hilltop.cents, hilltop.total], [1700, 2300]);
  assert.deepEqual(hilltop.extras, [{ label: 'Delivery', cents: 600 }]);
  assert.equal(store.get('orders', 'c1-meadow').total, 1700);
  assert.equal(catalog.left('hilltop/eggs'), 16);
  assert.equal(catalog.left('hilltop/greens'), 0);
  assert.deepEqual(cart.lines('rosa'), []);
  assert.equal(JSON.stringify(store.under('orders')).includes('4242'), false, 'the card is never stored');
  assert.equal(JSON.stringify(store.under('payments')).includes('4242'), false);
});

test('one group: the order is the checkout id', async () => {
  const { checkout, cart, store } = await setup();
  await cart.add('rosa', 'hilltop/eggs');
  assert.deepEqual((await checkout.checkout('rosa', { method: CARD })).orders, ['c1']);
  assert.equal(store.get('orders', 'c1').total, 600);
});

test('declined: the stock and the cart are put back, no order, and it can be tried again', async () => {
  const { checkout, cart, catalog, store } = await setup();
  await cart.add('rosa', 'hilltop/eggs', 2);
  await cart.add('rosa', 'hilltop/greens');
  assert.deepEqual(await checkout.checkout('rosa', { method: { card: FAILING_CARD } }), { error: 'declined' });
  assert.equal(catalog.left('hilltop/eggs'), 18);
  assert.equal(catalog.left('hilltop/greens'), 1);
  assert.deepEqual(cart.lines('rosa'), [{ item: 'hilltop/eggs', qty: 2 }, { item: 'hilltop/greens', qty: 1 }]);
  assert.deepEqual(store.under('orders'), []);
  assert.equal((await checkout.checkout('rosa', { method: CARD })).ok, true);
});

test('a double press: one checkout, one charge', async () => {
  const provider = heldProvider();
  const { checkout, cart, catalog } = await setup({ provider });
  await cart.add('rosa', 'hilltop/eggs', 2);
  const first = checkout.checkout('rosa', { method: CARD });
  const second = checkout.checkout('rosa', { method: CARD });
  assert.deepEqual(await second, { error: 'empty' }, 'the cart was emptied before the first awaited anything');
  await provider.answer({ ok: true, ref: 'r1' });
  assert.equal((await first).ok, true);
  assert.equal(provider.calls, 1);
  assert.equal(catalog.left('hilltop/eggs'), 16);
});

test('two buyers for the last one: one pays, the other is told before paying', async () => {
  const provider = heldProvider();
  const { checkout, cart, catalog } = await setup({ provider });
  await cart.add('rosa', 'hilltop/greens');
  await cart.add('sam', 'hilltop/greens');
  const rosa = checkout.checkout('rosa', { method: CARD });
  const sam = await checkout.checkout('sam', { method: CARD });
  assert.deepEqual(sam, { error: 'changed', lines: [{ item: 'hilltop/greens', qty: 1, name: 'Salad greens', unit: 'bag', left: 0, each: 0, cents: 0, problem: 'gone' }] }, 'held while rosa pays');
  await provider.answer({ ok: true, ref: 'r1' });
  assert.equal((await rosa).ok, true);
  assert.equal(provider.calls, 1);
  assert.equal(catalog.left('hilltop/greens'), 0);
});

test('a payment that fails gives the stock back to the next buyer', async () => {
  const provider = heldProvider();
  const { checkout, cart, catalog } = await setup({ provider });
  await cart.add('rosa', 'hilltop/greens');
  const rosa = checkout.checkout('rosa', { method: CARD });
  assert.equal(catalog.left('hilltop/greens'), 0);
  await provider.answer({ error: 'declined' });
  assert.deepEqual(await rosa, { error: 'declined' });
  assert.equal(catalog.left('hilltop/greens'), 1);
  await cart.add('sam', 'hilltop/greens');
  const sam = checkout.checkout('sam', { method: CARD });
  await provider.answer({ ok: true, ref: 'r2' });
  assert.equal((await sam).ok, true);
});

test('lines added while a payment was out are kept when it fails', async () => {
  const provider = heldProvider();
  const { checkout, cart } = await setup({ provider });
  await cart.add('rosa', 'hilltop/eggs', 2);
  const out = checkout.checkout('rosa', { method: CARD });
  await cart.add('rosa', 'hilltop/eggs', 1);
  await cart.add('rosa', 'meadow/honey', 1);
  await provider.answer({ error: 'declined' });
  await out;
  assert.deepEqual(cart.lines('rosa'), [{ item: 'hilltop/eggs', qty: 3 }, { item: 'meadow/honey', qty: 1 }]);
});

test('a cart that changed since it was shown is refused, and nothing is taken', async () => {
  const { checkout, cart, catalog } = await setup();
  await cart.add('rosa', 'hilltop/eggs', 2);
  await cart.add('rosa', 'hilltop/greens');
  await catalog.put('hilltop/greens', { qty: 0 });
  const refused = await checkout.checkout('rosa', { method: CARD });
  assert.equal(refused.error, 'changed');
  assert.equal(refused.lines[1].problem, 'gone');
  assert.equal(catalog.left('hilltop/eggs'), 18);
  assert.equal(cart.lines('rosa').length, 2, 'the cart is left for them to fix');
  assert.deepEqual(await checkout.checkout('sam', { method: CARD }), { error: 'empty' });
  assert.deepEqual(await checkout.checkout('', { method: CARD }), { error: 'no-holder' });
});

test('extras see each order and the details', async () => {
  const extras = ({ group, cents }, { pickup }) => (pickup ? [] : [{ label: `Delivery from ${group}`, cents: cents > 2000 ? 0 : 600 }]);
  const { checkout, cart } = await setup({ group: (item) => item.split('/')[0], extras });
  await cart.add('rosa', 'hilltop/eggs', 4);
  await cart.add('rosa', 'meadow/honey');
  const delivered = checkout.quote('rosa');
  assert.deepEqual(delivered.orders.map((order) => order.extras), [[{ label: 'Delivery from hilltop', cents: 0 }], [{ label: 'Delivery from meadow', cents: 600 }]]);
  assert.equal(checkout.quote('rosa', { pickup: true }).total, 2400 + 1100);
});

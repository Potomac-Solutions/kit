import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../../catalog/index.js';
import { createCart } from '../index.js';

async function setup(options) {
  const store = memoryStore();
  const catalog = createCatalog({ store });
  await catalog.put('hilltop/eggs', { name: 'Pasture eggs', unit: 'dozen', cents: 600, qty: 18 });
  await catalog.put('hilltop/greens', { name: 'Salad greens', unit: 'bag', cents: 500, qty: 2 });
  await catalog.put('meadow/lesson', { name: 'Beekeeping lesson', cents: 4000, qty: null });
  return { store, catalog, cart: createCart({ store, catalog, ...options }) };
}

test('add, set and remove; lines keep their order', async () => {
  const { cart } = await setup();
  assert.deepEqual(await cart.add('rosa', 'hilltop/eggs'), { ok: true, qty: 1 });
  await cart.add('rosa', 'meadow/lesson', 2);
  await cart.add('rosa', 'hilltop/eggs', 2);
  assert.deepEqual(cart.lines('rosa'), [{ item: 'hilltop/eggs', qty: 3 }, { item: 'meadow/lesson', qty: 2 }]);
  await cart.set('rosa', 'hilltop/eggs', 1);
  assert.deepEqual(cart.lines('rosa')[0], { item: 'hilltop/eggs', qty: 1 }, 'changed in place');
  await cart.remove('rosa', 'hilltop/eggs');
  assert.deepEqual(cart.lines('rosa'), [{ item: 'meadow/lesson', qty: 2 }]);
  assert.deepEqual(cart.lines('sam'), [], 'each holder has their own');
  await cart.clear('rosa');
  assert.deepEqual(cart.lines('rosa'), []);
});

test('what cannot be had now is refused', async () => {
  const { cart } = await setup({ maxQty: 10 });
  assert.deepEqual(await cart.add('rosa', 'hilltop/greens', 3), { error: 'short', item: 'hilltop/greens', left: 2 });
  await cart.add('rosa', 'hilltop/greens', 2);
  assert.deepEqual(await cart.add('rosa', 'hilltop/greens'), { error: 'short', item: 'hilltop/greens', left: 2 }, 'counting what is already in the cart');
  assert.deepEqual(await cart.add('rosa', 'nope'), { error: 'gone', item: 'nope' });
  assert.deepEqual(await cart.add('rosa', 'meadow/lesson', 11), { error: 'bad-qty', max: 10 });
  assert.deepEqual(await cart.add('rosa', 'meadow/lesson', 0), { error: 'bad-qty', max: 10 });
  assert.deepEqual(await cart.set('rosa', 'meadow/lesson', 1.5), { error: 'bad-qty', max: 10 });
  assert.deepEqual(await cart.add('', 'meadow/lesson'), { error: 'no-holder' });
  assert.deepEqual(await cart.remove('rosa', 'nope'), { ok: true, qty: 0 }, 'taking out what is gone is fine');
});

test('view prices from the catalog now, and says what has changed', async () => {
  const { cart, catalog } = await setup();
  await cart.add('rosa', 'hilltop/eggs', 2);
  await cart.add('rosa', 'hilltop/greens', 2);
  await cart.add('rosa', 'meadow/lesson');
  assert.deepEqual(cart.view('rosa'), {
    lines: [
      { item: 'hilltop/eggs', qty: 2, name: 'Pasture eggs', unit: 'dozen', left: 18, each: 600, cents: 1200 },
      { item: 'hilltop/greens', qty: 2, name: 'Salad greens', unit: 'bag', left: 2, each: 500, cents: 1000 },
      { item: 'meadow/lesson', qty: 1, name: 'Beekeeping lesson', unit: '', left: Infinity, each: 4000, cents: 4000 },
    ],
    cents: 6200,
    count: 5,
    ok: true,
  });
  await catalog.put('hilltop/eggs', { cents: 650 });
  await catalog.take([{ item: 'hilltop/greens', qty: 1 }]);
  await catalog.put('meadow/lesson', { active: false });
  const view = cart.view('rosa');
  assert.equal(view.lines[0].cents, 1300, 'the price now, not when it was added');
  assert.equal(view.lines[1].problem, 'short');
  assert.equal(view.lines[1].left, 1);
  assert.equal(view.lines[2].problem, 'gone');
  assert.equal(view.cents, 1300, 'the subtotal counts only what can be had');
  assert.equal(view.ok, false);
  assert.equal(cart.view('sam').ok, false, 'an empty cart cannot be checked out');
});

test('priceOf adjusts each price, given the context', async () => {
  const { cart } = await setup({ priceOf: (item, { member }) => (member ? Math.round(item.cents * 0.9) : item.cents) });
  await cart.add('rosa', 'hilltop/eggs', 2);
  assert.equal(cart.view('rosa').cents, 1200);
  assert.equal(cart.view('rosa', { member: true }).cents, 1080);
});

test('a malformed stored cart reads as its good lines', async () => {
  const { cart, store } = await setup();
  await store.write('carts', 'rosa', { lines: [{ item: 'hilltop/eggs', qty: 1 }, null, { item: 3, qty: 1 }, { item: 'hilltop/greens', qty: -1 }] });
  assert.deepEqual(cart.lines('rosa'), [{ item: 'hilltop/eggs', qty: 1 }]);
});

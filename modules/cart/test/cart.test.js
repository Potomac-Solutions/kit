import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../../catalog/index.js';
import { createCart } from '../index.js';

const setup = async () => {
  const store = memoryStore();
  await store.write('items', 'hill/eggs', { name: 'Eggs', unit: 'dozen', cents: 600, left: 5 });
  await store.write('items', 'vale/beef', { name: 'Beef', unit: 'lb', cents: 899, left: 20 });
  const catalog = createCatalog({ store, rules: [{ label: 'Member', when: { member: true }, percent: -10 }] });
  return { store, catalog, cart: createCart({ store, catalog, max: 10 }) };
};

test('add, set and remove lines, one field per item', async () => {
  const { store, cart } = await setup();
  assert.deepEqual(await cart.add('ada', 'hill/eggs'), { ok: true, item: 'hill/eggs', qty: 1 });
  assert.deepEqual(await cart.add('ada', 'hill/eggs', 2), { ok: true, item: 'hill/eggs', qty: 3 });
  await cart.set('ada', 'vale/beef', 2);
  assert.deepEqual(store.get('carts', 'ada'), { 'hill/eggs': 3, 'vale/beef': 2 });
  await cart.remove('ada', 'hill/eggs');
  assert.deepEqual(store.get('carts', 'ada'), { 'hill/eggs': 0, 'vale/beef': 2 });
  assert.deepEqual(cart.view('ada').lines.map((line) => line.item), ['vale/beef'], 'a removed line is gone from the view');
});

test('refuses what cant be bought', async () => {
  const { cart } = await setup();
  assert.deepEqual(await cart.add('ada', 'nope'), { error: 'gone', item: 'nope' });
  assert.deepEqual(await cart.set('ada', 'hill/eggs', 6), { error: 'sold-out', item: 'hill/eggs', left: 5 });
  assert.deepEqual(await cart.set('ada', 'vale/beef', 11), { error: 'too-many', max: 10 });
  assert.deepEqual(await cart.set('ada', 'vale/beef', -1), { error: 'bad-qty' });
  assert.deepEqual(await cart.add('ada', 'vale/beef', 0), { error: 'bad-qty' });
  assert.deepEqual(await cart.set('', 'vale/beef', 1), { error: 'no-owner' });
});

test('the view prices each line now, and totals it', async () => {
  const { cart } = await setup();
  await cart.set('ada', 'hill/eggs', 2);
  await cart.set('ada', 'vale/beef', 3);
  assert.deepEqual(cart.view('ada', { member: true }), {
    lines: [
      { item: 'hill/eggs', qty: 2, name: 'Eggs', unit: 'dozen', cents: 540, total: 1080, left: 5, short: false },
      { item: 'vale/beef', qty: 3, name: 'Beef', unit: 'lb', cents: 809, total: 2427, left: 20, short: false },
    ],
    count: 5,
    cents: 3507,
    ready: true,
  });
  assert.deepEqual(cart.view('bo'), { lines: [], count: 0, cents: 0, ready: false }, 'an empty cart is not ready');
});

test('a line that sold out or went away since is flagged, and the cart is not ready', async () => {
  const { store, cart } = await setup();
  await cart.set('ada', 'hill/eggs', 4);
  await cart.set('ada', 'vale/beef', 1);
  await store.write('items', 'hill/eggs', { left: 2 });
  let view = cart.view('ada');
  assert.equal(view.ready, false);
  assert.deepEqual(view.lines[0], { item: 'hill/eggs', qty: 4, name: 'Eggs', unit: 'dozen', cents: 600, total: 2400, left: 2, short: true });
  assert.equal(view.cents, 899, 'only lines that can be bought count');
  await store.write('items', 'hill/eggs', { name: '' });
  view = cart.view('ada');
  assert.deepEqual(view.lines[0], { item: 'hill/eggs', qty: 4, gone: true, cents: 0, total: 0 });
});

test('clear takes out what was bought and keeps what was added since', async () => {
  const { store, cart } = await setup();
  await cart.set('ada', 'hill/eggs', 2);
  const bought = cart.view('ada').lines;
  await cart.set('ada', 'hill/eggs', 3); // another tab, meanwhile
  await cart.set('ada', 'vale/beef', 1);
  await cart.clear('ada', bought);
  assert.deepEqual(store.get('carts', 'ada'), { 'hill/eggs': 1, 'vale/beef': 1 });
  await cart.clear('ada');
  assert.equal(cart.view('ada').count, 0);
});

test('an item with no limit is never short', async () => {
  const { store, cart } = await setup();
  await store.write('items', 'vale/tour', { name: 'Farm tour', cents: 2500, left: null });
  assert.deepEqual(await cart.set('ada', 'vale/tour', 10), { ok: true, item: 'vale/tour', qty: 10 });
  const view = cart.view('ada');
  assert.equal(view.lines[0].short, false);
  assert.equal(view.lines[0].left, null);
  assert.equal(view.ready, true);
});

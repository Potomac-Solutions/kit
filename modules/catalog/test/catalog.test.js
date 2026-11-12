import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../index.js';

const shelf = async (options = {}) => {
  const store = memoryStore();
  await store.write('items', 'hill/eggs', { name: 'Eggs ', unit: 'dozen', cents: 600, left: 5 });
  await store.write('items', 'hill/honey', { name: 'Honey', cents: 1200, left: 0 });
  await store.write('items', 'hill/draft', { name: '', cents: 100, left: 3 });
  await store.write('items', 'vale/beef', { name: 'Ground beef', unit: 'lb', cents: 899, left: 20, tags: { kind: 'meat' } });
  return { store, catalog: createCatalog({ store, ...options }) };
};

test('items for sale: named, priced, in stock, in key order', async () => {
  const { catalog } = await shelf();
  assert.deepEqual(catalog.items().map((item) => item.key), ['hill/eggs', 'vale/beef']);
  assert.deepEqual(catalog.items('hill/'), [{ key: 'hill/eggs', name: 'Eggs', unit: 'dozen', base: 600, cents: 600, applied: [], left: 5 }]);
  assert.deepEqual(catalog.items('hill/', {}, { all: true }).map((item) => item.key), ['hill/eggs', 'hill/honey'], 'all keeps sold out, never unnamed');
  assert.equal(catalog.item('hill/honey').left, 0);
  assert.equal(catalog.item('hill/draft'), null);
  assert.equal(catalog.item('nope'), null);
  assert.equal(catalog.items('vale/')[0].unit, 'lb');
  assert.equal(catalog.item('hill/honey').unit, 'each');
});

test('prices run the rules with the context, the key and the tags', async () => {
  const rules = [
    { label: 'Member', when: { member: true }, percent: -10 },
    { label: 'Meat sale', when: { kind: 'meat' }, add: -100 },
    { label: 'Eggs Tuesday', when: { item: 'hill/eggs', day: 2 }, set: 500 },
  ];
  const { catalog } = await shelf({ rules });
  assert.deepEqual(catalog.item('vale/beef', { member: true }), { key: 'vale/beef', name: 'Ground beef', unit: 'lb', base: 899, cents: 709, applied: ['Member', 'Meat sale'], left: 20 });
  assert.equal(catalog.item('hill/eggs', { day: 2 }).cents, 500);
  assert.equal(catalog.item('hill/eggs', { day: 3 }).cents, 600);
});

test('an app with its own fields reads them through `read`, `left` and `listed`', async () => {
  const store = memoryStore();
  // Tailgate's shape: price in dollars, stock in `qty`, listed on the farm's document.
  await store.write('farms', 'hill', { items: ['eggs'] });
  await store.write('listings', 'hill/eggs', { name: 'Eggs', price: '6.50', qty: 4 });
  await store.write('listings', 'hill/old', { name: 'Old', price: '1', qty: 4 });
  const catalog = createCatalog({
    store,
    collection: 'listings',
    left: 'qty',
    read: (doc) => ({ name: doc.name, unit: doc.unit, cents: Math.round(Number(doc.price) * 100), left: doc.qty }),
    listed: (key) => (store.get('farms', key.split('/')[0])?.items ?? []).includes(key.split('/')[1]),
  });
  assert.deepEqual(catalog.items().map((item) => [item.key, item.cents]), [['hill/eggs', 650]]);
  const taken = catalog.take([{ item: 'hill/eggs', qty: 3 }]);
  assert.equal(taken.ok, true);
  assert.equal(store.get('listings', 'hill/eggs').qty, 1, 'take writes the named field');
  assert.deepEqual(catalog.take([{ item: 'hill/old', qty: 1 }]), { error: 'gone', item: 'hill/old' }, 'an unlisted item cannot be taken');
});

test('take is all or nothing, stored before it returns', async () => {
  const { store, catalog } = await shelf();
  assert.deepEqual(catalog.take([{ item: 'hill/eggs', qty: 2 }, { item: 'vale/beef', qty: 21 }]), { error: 'sold-out', item: 'vale/beef', left: 20 });
  assert.equal(store.get('items', 'hill/eggs').left, 5, 'nothing was taken');
  const taken = catalog.take([{ item: 'hill/eggs', qty: 2 }, { item: 'vale/beef', qty: 20 }]);
  assert.equal(taken.ok, true);
  assert.equal(store.get('items', 'hill/eggs').left, 3, 'stored before the promise');
  assert.equal(store.get('items', 'vale/beef').left, 0);
  await taken.sent;
  assert.equal(catalog.items('vale/').length, 0, 'gone from the shelf');
});

test('take adds up the same item on two lines', async () => {
  const { catalog } = await shelf();
  assert.deepEqual(catalog.take([{ item: 'hill/eggs', qty: 3 }, { item: 'hill/eggs', qty: 3 }]), { error: 'sold-out', item: 'hill/eggs', left: 5 });
});

test('take refuses nothing, a bad quantity, and what isnt for sale', async () => {
  const { catalog } = await shelf();
  assert.deepEqual(catalog.take([]), { error: 'empty' });
  assert.deepEqual(catalog.take([{ item: 'hill/eggs', qty: 0 }]), { error: 'bad-qty', item: 'hill/eggs' });
  assert.deepEqual(catalog.take([{ item: 'hill/eggs', qty: 1.5 }]), { error: 'bad-qty', item: 'hill/eggs' });
  assert.deepEqual(catalog.take([{ item: 'hill/draft', qty: 1 }]), { error: 'gone', item: 'hill/draft' });
});

test('two buyers of the last ones: exactly one wins', async () => {
  const { store, catalog } = await shelf();
  const buy = async (qty) => {
    await Promise.resolve();
    const taken = catalog.take([{ item: 'hill/eggs', qty }]);
    if (taken.ok) await taken.sent;
    return taken.ok ? 'got' : taken.error;
  };
  assert.deepEqual((await Promise.all([buy(4), buy(4), buy(4)])).sort(), ['got', 'sold-out', 'sold-out']);
  assert.equal(store.get('items', 'hill/eggs').left, 1);
});

test('restock puts stock back', async () => {
  const { store, catalog } = await shelf();
  await catalog.take([{ item: 'hill/eggs', qty: 2 }]).sent;
  await catalog.restock([{ item: 'hill/eggs', qty: 2 }, { item: 'nope', qty: 1 }]);
  assert.equal(store.get('items', 'hill/eggs').left, 5);
  assert.equal(store.get('items', 'nope'), null, 'nothing is made up');
});

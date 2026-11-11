import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../index.js';

async function stocked() {
  const store = memoryStore();
  const catalog = createCatalog({ store });
  await catalog.put('hilltop/eggs', { name: 'Pasture eggs', unit: 'dozen', cents: 600, qty: 18 });
  await catalog.put('hilltop/greens', { name: 'Salad greens', unit: 'bag', cents: 500, qty: 1 });
  await catalog.put('meadow/honey', { name: 'Wildflower honey', unit: 'jar', cents: 1100, qty: 0 });
  await catalog.put('meadow/lesson', { name: 'Beekeeping lesson', cents: 4000, qty: null });
  return { store, catalog };
}

test('list is what can be bought now, by section, in key order', async () => {
  const { catalog } = await stocked();
  assert.deepEqual(catalog.list().map((item) => item.key), ['hilltop/eggs', 'hilltop/greens', 'meadow/lesson']);
  assert.deepEqual(catalog.list('meadow/').map((item) => item.key), ['meadow/lesson']);
  assert.deepEqual(catalog.list('meadow/', { soldOut: true }).map((item) => item.key), ['meadow/honey', 'meadow/lesson']);
  await catalog.put('hilltop/eggs', { active: false });
  assert.deepEqual(catalog.list('hilltop/').map((item) => item.key), ['hilltop/greens'], 'hidden, not lost');
  assert.equal(catalog.get('hilltop/eggs').name, 'Pasture eggs');
});

test('left: a number, Infinity for no limit, 0 for what is not for sale', async () => {
  const { catalog } = await stocked();
  assert.equal(catalog.left('hilltop/eggs'), 18);
  assert.equal(catalog.left('meadow/lesson'), Infinity);
  assert.equal(catalog.left('meadow/honey'), 0);
  assert.equal(catalog.left('nope'), 0);
  await catalog.put('hilltop/eggs', { cents: 0 });
  assert.equal(catalog.left('hilltop/eggs'), 0, 'an item with no price is not for sale');
});

test('put checks what it is given', async () => {
  const { catalog } = await stocked();
  assert.deepEqual(await catalog.put('bad key!', { name: 'x', cents: 1 }), { error: 'bad-key' });
  assert.deepEqual(await catalog.put('a/b/c', { name: 'x', cents: 1 }), { error: 'bad-key' });
  assert.deepEqual(await catalog.put('x', { name: ' ', cents: 1 }), { error: 'bad-name' });
  assert.deepEqual(await catalog.put('x', { name: 'X', cents: 1.5 }), { error: 'bad-price' });
  assert.deepEqual(await catalog.put('x', { name: 'X', cents: -1 }), { error: 'bad-price' });
  assert.deepEqual(await catalog.put('x', { name: 'X', cents: 1, qty: -2 }), { error: 'bad-qty' });
  assert.deepEqual(await catalog.put('x', { name: 'X' }), { error: 'incomplete' }, 'a new item needs a name and a price');
  assert.deepEqual(await catalog.put('hilltop/eggs', { qty: 5 }), { ok: true }, 'a known one can change one field');
  assert.equal(catalog.get('hilltop/eggs').qty, 5);
});

test('take is all or nothing, and says which line could not be had', async () => {
  const { catalog } = await stocked();
  assert.deepEqual(await catalog.take([{ item: 'hilltop/eggs', qty: 2 }, { item: 'hilltop/greens', qty: 2 }]), { error: 'short', item: 'hilltop/greens', left: 1 });
  assert.equal(catalog.left('hilltop/eggs'), 18, 'nothing was taken');
  assert.deepEqual(await catalog.take([{ item: 'meadow/honey', qty: 1 }]), { error: 'gone', item: 'meadow/honey' });
  assert.deepEqual(await catalog.take([{ item: 'hilltop/eggs', qty: 0 }]), { error: 'bad-qty', item: 'hilltop/eggs' });
  assert.deepEqual(await catalog.take([]), { error: 'empty' });
  assert.deepEqual(await catalog.take([{ item: 'hilltop/eggs', qty: 2 }, { item: 'meadow/lesson', qty: 3 }, { item: 'hilltop/eggs', qty: 1 }]), { ok: true });
  assert.equal(catalog.left('hilltop/eggs'), 15, 'the same item twice is taken once, for both');
  assert.equal(catalog.get('meadow/lesson').qty, null, 'no limit stays no limit');
  assert.deepEqual(await catalog.take([{ item: 'hilltop/eggs', qty: 10 }, { item: 'hilltop/eggs', qty: 6 }]), { error: 'short', item: 'hilltop/eggs', left: 15 });
});

test('two buyers for the last one: exactly one gets it', async () => {
  const { catalog } = await stocked();
  const results = await Promise.all([catalog.take([{ item: 'hilltop/greens', qty: 1 }]), catalog.take([{ item: 'hilltop/greens', qty: 1 }])]);
  assert.deepEqual(results.map((r) => r.ok ?? r.error).sort(), ['gone', true]);
  assert.equal(catalog.left('hilltop/greens'), 0);
});

test('check answers synchronously, as take would', async () => {
  const { catalog } = await stocked();
  assert.equal(catalog.check([{ item: 'hilltop/eggs', qty: 18 }]), null);
  assert.deepEqual(catalog.check([{ item: 'hilltop/eggs', qty: 19 }]), { error: 'short', item: 'hilltop/eggs', left: 18 });
});

test('give puts stock back', async () => {
  const { catalog } = await stocked();
  await catalog.take([{ item: 'hilltop/eggs', qty: 4 }]);
  await catalog.give([{ item: 'hilltop/eggs', qty: 3 }, { item: 'hilltop/eggs', qty: 1 }, { item: 'meadow/lesson', qty: 2 }, { item: 'nope', qty: 1 }]);
  assert.equal(catalog.left('hilltop/eggs'), 18);
  assert.equal(catalog.get('meadow/lesson').qty, null);
  assert.equal(catalog.get('nope'), null);
});

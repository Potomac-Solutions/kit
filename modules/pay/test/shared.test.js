// One store and one `pay` behind both a shop (checkout) and rentals (reserve), as an outfitter
// would run them. A key is chosen by the page, so the two must never share a payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../../catalog/index.js';
import { createCart } from '../../cart/index.js';
import { createCheckout } from '../../checkout/index.js';
import { createPay, testProvider, FAILING_CARD } from '../index.js';
import { createStages } from '../../stages/index.js';
import { createHolds } from '../../hold/index.js';
import { createReserve } from '../../reserve/index.js';

async function outfitter() {
  const store = memoryStore();
  const provider = testProvider();
  const charges = [];
  const pay = createPay({ provider: { charge: async (c) => (charges.push(c.cents), provider.charge(c)) }, store });
  const catalog = createCatalog({ store });
  await catalog.put('gear/drysuit', { name: 'Drysuit', cents: 89900, left: 3 });
  const cart = createCart({ store, catalog });
  const checkout = createCheckout({ store, catalog, cart, pay, stages: createStages({ store, collection: 'orders', steps: ['placed', 'shipped'] }) });
  const reserve = createReserve({ store, holds: createHolds({ store, max: 4 }), pay, stages: createStages({ store, collection: 'rentals', steps: ['booked', 'out'] }), base: 500 });
  return { store, cart, checkout, reserve, charges };
}

test("a booking's payment doesn't pay for a checkout with the same key", async () => {
  const { store, cart, checkout, reserve, charges } = await outfitter();
  await reserve.hold('mallory', { key: 'k', pools: ['kayaks/2026-11-20'], units: ['k1'] });
  assert.equal((await reserve.book('mallory', 'k', { method: { card: '4242' } })).ok, true);
  await cart.add('mallory', 'gear/drysuit', 1);
  assert.deepEqual(await checkout.place('mallory', { key: 'k', method: { card: FAILING_CARD } }), { error: 'declined', key: 'k' });
  assert.deepEqual(charges, [500, 89900]);
  assert.equal(store.get('payments', 'booking/k').state, 'paid');
  assert.equal(store.get('payments', 'checkout/k').state, 'failed');
});

test("someone else's checkout payment doesn't pay for a booking with the same key", async () => {
  const { store, cart, checkout, reserve, charges } = await outfitter();
  await cart.add('ada', 'gear/drysuit', 1);
  assert.equal((await checkout.place('ada', { key: 'c', method: { card: '4242' } })).ok, true);
  await reserve.hold('mallory', { key: 'c', pools: ['kayaks/2026-11-20'], units: ['k1', 'k2', 'k3'] });
  assert.deepEqual(await reserve.book('mallory', 'c', { method: { card: FAILING_CARD } }), { error: 'declined', key: 'c' });
  assert.deepEqual(charges, [89900, 1500]);
  assert.equal(store.get('payments', 'checkout/c').state, 'paid');
  assert.equal(store.get('payments', 'booking/c').state, 'failed');
});

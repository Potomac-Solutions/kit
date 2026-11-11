import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createPay, testProvider, FAILING_CARD } from '../index.js';

const counting = (answer = async () => ({ ok: true, ref: 'r1' })) => {
  const calls = [];
  return { calls, charge: async (charge) => (calls.push(charge), answer(charge)) };
};

test('an order is charged and recorded', async () => {
  const store = memoryStore();
  const provider = counting();
  const pay = createPay({ provider, store, now: () => 42 });
  assert.deepEqual(await pay.pay({ id: 'o1', cents: 2200, description: '2 tickets', method: { card: '4242424242424242' } }), { ok: true, ref: 'r1' });
  assert.deepEqual(pay.paid('o1'), { state: 'paid', cents: 2200, currency: 'usd', ref: 'r1', reason: '', at: 42 });
  assert.deepEqual(provider.calls[0], { id: 'o1', cents: 2200, currency: 'usd', description: '2 tickets', method: { card: '4242424242424242' } });
  assert.equal(JSON.stringify(store.under('payments')).includes('4242'), false, 'the card is never stored');
});

test('a double press charges once', async () => {
  const provider = counting();
  const pay = createPay({ provider, store: memoryStore() });
  const [first, second] = await Promise.all([pay.pay({ id: 'o1', cents: 500 }), pay.pay({ id: 'o1', cents: 500 })]);
  assert.deepEqual(first, { ok: true, ref: 'r1' });
  assert.deepEqual(second, { error: 'in-progress' });
  assert.deepEqual(await pay.pay({ id: 'o1', cents: 500 }), { ok: true, ref: 'r1', again: true }, 'a retry after success returns the first payment');
  assert.equal(provider.calls.length, 1);
});

test('a declined order can be tried again', async () => {
  const pay = createPay({ provider: testProvider(), store: memoryStore() });
  assert.deepEqual(await pay.pay({ id: 'o1', cents: 500, method: { card: '4000 0000 0000 0002' } }), { error: 'declined' });
  assert.equal(pay.paid('o1').state, 'failed');
  assert.equal(pay.paid('o1').reason, 'declined');
  assert.deepEqual(await pay.pay({ id: 'o1', cents: 500, method: { card: '4242 4242 4242 4242' } }), { ok: true, ref: 'test_1' });
  assert.equal(FAILING_CARD, '4000000000000002');
});

test('a provider that throws is a failed payment, not a crash, and not a stuck one', async () => {
  let broken = true;
  const pay = createPay({ provider: { charge: async () => (broken ? Promise.reject(new Error('network down')) : { ok: true, ref: 'r2' }) }, store: memoryStore() });
  assert.deepEqual(await pay.pay({ id: 'o1', cents: 500 }), { error: 'provider-failed' });
  broken = false;
  assert.deepEqual(await pay.pay({ id: 'o1', cents: 500 }), { ok: true, ref: 'r2' });
});

test('bad orders never reach the provider', async () => {
  const provider = counting();
  const pay = createPay({ provider, store: memoryStore() });
  assert.deepEqual(await pay.pay({ cents: 500 }), { error: 'no-order' });
  for (const cents of [0, -5, 9.99, '500', undefined]) assert.deepEqual(await pay.pay({ id: 'o1', cents }), { error: 'bad-amount' });
  assert.equal(provider.calls.length, 0);
  assert.equal(pay.paid('o1'), null);
  assert.throws(() => createPay({ store: memoryStore() }), /provider/);
  assert.throws(() => createPay({ provider }), /store/);
});

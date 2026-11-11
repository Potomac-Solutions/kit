import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createStages } from '../index.js';

// Tailgate's delivery: placed, claimed by a driver, picked up, delivered.
const delivery = (extra = {}) => {
  const store = memoryStore();
  let t = 5000;
  const stages = createStages({ store, collection: 'orders', steps: ['placed', 'claimed', 'picked', 'delivered'], owner: 'driver', now: () => t++, ...extra });
  return { store, stages };
};

test('a record starts at the first step, once', async () => {
  const { store, stages } = delivery();
  assert.deepEqual(await stages.start('o1', { farm: 'f1', qty: 2 }), { ok: true, at: 'placed' });
  assert.deepEqual(store.get('orders', 'o1'), { farm: 'f1', qty: 2, status: 'placed', placed: 5000 });
  assert.deepEqual(await stages.start('o1'), { error: 'exists' });
  assert.equal(stages.at('o1'), 'placed');
  assert.equal(stages.at('nope'), null);
});

test('two drivers claim at once and exactly one wins', async () => {
  const { store, stages } = delivery();
  await stages.start('o1');
  const [first, second] = await Promise.all([stages.claim('o1', 'dana', { driverName: 'Dana' }), stages.claim('o1', 'eli', { driverName: 'Eli' })]);
  assert.deepEqual(first, { ok: true, at: 'claimed' });
  assert.deepEqual(second, { error: 'claimed', by: 'dana', yours: false });
  assert.equal(store.get('orders', 'o1').driverName, 'Dana');
  assert.deepEqual(await stages.claim('o1', 'dana'), { error: 'claimed', by: 'dana', yours: true });
  assert.deepEqual(await stages.claim('gone', 'dana'), { error: 'missing' });
});

test('only the owner advances, one step at a time', async () => {
  const { store, stages } = delivery();
  await stages.start('o1');
  await stages.claim('o1', 'dana');
  assert.deepEqual(await stages.advance('o1', 'picked', { by: 'eli' }), { error: 'refused' });
  assert.deepEqual(await stages.advance('o1', 'delivered', { by: 'dana' }), { error: 'wrong-step', at: 'claimed' });
  assert.deepEqual(await stages.advance('o1', 'picked', { by: 'dana' }), { ok: true, at: 'picked' });
  assert.deepEqual(await stages.advance('o1', 'picked', { by: 'dana' }), { error: 'wrong-step', at: 'picked' }, 'a step is not taken twice');
  assert.deepEqual(await stages.advance('o1', 'delivered', { by: 'dana', set: { signedBy: 'Pat' } }), { ok: true, at: 'delivered' });
  const order = store.get('orders', 'o1');
  assert.equal(order.signedBy, 'Pat');
  assert.ok(order.placed < order.claimed && order.claimed < order.picked && order.picked < order.delivered, 'each step is stamped');
  assert.deepEqual(await stages.advance('o1', 'shipped', { by: 'dana' }), { error: 'unknown-step', to: 'shipped' });
  assert.deepEqual(await stages.advance('o1', 'placed', { by: 'dana' }), { error: 'unknown-step', to: 'placed' });
  assert.deepEqual(await stages.advance('gone', 'picked', { by: 'dana' }), { error: 'missing' });
});

test('a claim needs the record to be at the first step', async () => {
  const { store, stages } = delivery();
  await store.write('orders', 'o9', { status: 'delivered', driver: '' });
  assert.deepEqual(await stages.claim('o9', 'dana'), { error: 'wrong-step', at: 'delivered' });
});

test('a side step is reachable only from the steps it names', async () => {
  const { stages } = delivery({ from: { cancelled: ['placed', 'claimed'] }, may: () => true });
  await stages.start('o1');
  await stages.start('o2');
  assert.deepEqual(await stages.advance('o1', 'cancelled'), { ok: true, at: 'cancelled' });
  await stages.claim('o2', 'dana');
  await stages.advance('o2', 'picked');
  assert.deepEqual(await stages.advance('o2', 'cancelled'), { error: 'wrong-step', at: 'picked' });
  assert.deepEqual(await stages.advance('o1', 'claimed'), { error: 'wrong-step', at: 'cancelled' }, 'nothing follows a cancelled order');
});

test('stamps can be limited or switched off, and may() can be the app’s own rule', async () => {
  const some = delivery({ stamp: ['delivered'] });
  await some.stages.start('o1');
  await some.stages.claim('o1', 'dana');
  assert.deepEqual(some.store.get('orders', 'o1'), { status: 'claimed', driver: 'dana' });

  // A work ticket with no owner: staff advance it, the customer can't.
  const store = memoryStore();
  const ticket = createStages({ store, collection: 'jobs', steps: ['dropped-off', 'in-work', 'ready', 'collected'], field: 'stage', stamp: false, may: ({ by }) => by?.staff === true });
  await ticket.start('j1', { what: 'shoulder mount' });
  assert.deepEqual(await ticket.advance('j1', 'in-work', { by: { staff: false } }), { error: 'refused' });
  assert.deepEqual(await ticket.advance('j1', 'in-work', { by: { staff: true } }), { ok: true, at: 'in-work' });
  assert.deepEqual(store.get('jobs', 'j1'), { what: 'shoulder mount', stage: 'in-work' });
  await assert.rejects(() => ticket.claim('j1', 'sam'), /owner/);
});

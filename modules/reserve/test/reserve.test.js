import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createHolds } from '../../hold/index.js';
import { createPay, testProvider, FAILING_CARD } from '../../pay/index.js';
import { createStages } from '../../stages/index.js';
import { moment } from '../../price/index.js';
import { createReserve } from '../index.js';

const CARD = { card: '4242' };
const FLEET = ['k1', 'k2', 'k3', 'k10'];
const FRI = 'kayaks/2026-11-20';
const SAT = 'kayaks/2026-11-21';
const SUN = 'kayaks/2026-11-22';
const WEEKEND = [FRI, SAT, SUN];

const clock = (start = 1_000_000) => {
  let t = start;
  const now = () => t;
  now.add = (ms) => (t += ms);
  return now;
};

/** An outfitter: $40 a kayak a day, $50 on Saturday and Sunday; a counting provider. */
function outfitter({ provider = testProvider(), now = clock(), holdMs = 5 * 60_000, payMs = 2 * 60_000 } = {}) {
  const store = memoryStore();
  const holds = createHolds({ store, holdMs, max: 4, now });
  const charges = [];
  const counted = { charge: async (charge) => (charges.push(charge), provider.charge(charge)) };
  const reserve = createReserve({
    store,
    holds,
    pay: createPay({ provider: counted, store }),
    stages: createStages({ store, collection: 'rentals', steps: ['booked', 'out', 'returned'], stamp: false }),
    base: 4000,
    rules: [{ label: 'Weekend', when: { day: [0, 6] }, set: 5000 }],
    context: (pool) => moment(new Date(`${pool.split('/')[1]}T16:00:00Z`), 'America/New_York'),
    payMs,
    now,
  });
  return { store, holds, reserve, charges, now };
}

test('a kayak Friday to Sunday is all or nothing', async () => {
  const { holds, reserve } = outfitter();
  await holds.choose('bo', SUN, { units: ['k1'] });
  assert.deepEqual(await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] }), { error: 'taken', unit: 'k1', pool: SUN });
  assert.equal(holds.taken(FRI).size, 0, 'Friday was not held');
  const held = await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k2'] });
  assert.equal(held.ok, true);
  assert.deepEqual(held.lines.map((line) => [line.pool, line.cents]), [[FRI, 4000], [SAT, 5000], [SUN, 5000]]);
  assert.equal(held.cents, 14000);
});

test('with count, the same free kayak every day, in order', async () => {
  const { holds, reserve } = outfitter();
  await holds.choose('bo', SAT, { units: ['k1'] });
  await holds.choose('cy', FRI, { units: ['k2'] });
  assert.deepEqual(reserve.free(WEEKEND, FLEET), ['k3', 'k10']);
  const held = await reserve.hold('ada', { key: 'b1', pools: WEEKEND, count: 2, from: FLEET });
  assert.deepEqual(held.units, ['k3', 'k10']);
  assert.deepEqual(await reserve.hold('dee', { key: 'b2', pools: WEEKEND, count: 1, from: FLEET }), { error: 'none-free', left: 0 });
  assert.deepEqual(reserve.free(WEEKEND, FLEET, 'ada'), ['k3', 'k10'], 'a holder sees their own as free');
});

test('two people after the last kayak for overlapping weekends: one gets it', async () => {
  const { reserve, holds } = outfitter();
  const [ada, bo] = await Promise.all([
    reserve.hold('ada', { key: 'a', pools: [FRI, SAT], count: 1, from: ['k1'] }),
    reserve.hold('bo', { key: 'b', pools: [SAT, SUN], count: 1, from: ['k1'] }),
  ]);
  assert.equal([ada, bo].filter((answer) => answer.ok).length, 1);
  assert.equal(holds.taken(ada.ok ? SUN : FRI).size, 0, 'the loser held none of their days');
});

test('book: charged once, the price shown, confirmed every day, started', async () => {
  const { store, holds, reserve, charges } = outfitter();
  await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] });
  const [first, second] = await Promise.all([reserve.book('ada', 'b1', { method: CARD, fields: { phone: '555' } }), reserve.book('ada', 'b1', { method: CARD })]);
  assert.deepEqual(first, { ok: true, key: 'b1', ref: 'test_1', cents: 14000 });
  assert.deepEqual(second, { error: 'in-progress' });
  assert.deepEqual(await reserve.book('ada', 'b1', { method: CARD }), { ok: true, again: true, key: 'b1', ref: 'test_1', cents: 14000 });
  assert.equal(charges.length, 1);
  assert.equal(charges[0].cents, 14000);
  for (const pool of WEEKEND) assert.equal(holds.taken(pool).get('k1').state, 'taken');
  assert.equal(store.get('rentals', 'b1').status, 'booked');
  assert.equal(store.get('rentals', 'b1').phone, '555');
  assert.equal(store.get('bookings', 'b1').state, 'paid');
  assert.equal(JSON.stringify(store.under('bookings')).includes('4242'), false, 'the card is never stored');
});

test('declined: nothing confirmed, the holds stay until they lapse, and it can be tried again', async () => {
  const { holds, reserve, charges } = outfitter();
  await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] });
  assert.deepEqual(await reserve.book('ada', 'b1', { method: { card: FAILING_CARD } }), { error: 'declined', key: 'b1' });
  assert.equal(holds.taken(SAT).get('k1').state, 'held');
  assert.equal(reserve.get('b1').state, 'failed');
  assert.equal((await reserve.book('ada', 'b1', { method: CARD })).ok, true);
  assert.equal(charges.length, 2);
});

test('a hold that lapsed before booking is refused before any charge', async () => {
  const { holds, reserve, charges, now } = outfitter();
  await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] });
  now.add(5 * 60_000);
  await holds.choose('bo', SAT, { units: ['k1'] });
  assert.deepEqual(await reserve.book('ada', 'b1', { method: CARD }), { error: 'lapsed', pool: FRI, units: ['k1'] });
  assert.equal(charges.length, 0);
});

test('a payment slower than the hold but within payMs still books', async () => {
  const now = clock();
  let release;
  const slow = { charge: () => new Promise((resolve) => (release = () => resolve({ ok: true, ref: 'slow' }))) };
  const { holds, reserve } = outfitter({ provider: slow, now, holdMs: 60_000, payMs: 120_000 });
  await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] });
  now.add(50_000);
  const booking = reserve.book('ada', 'b1', { method: CARD });
  await new Promise((resolve) => setTimeout(resolve, 5));
  now.add(90_000); // past the 60s hold from when it was made, inside 120s from the booking
  assert.equal((await holds.choose('bo', SAT, { units: ['k1'] })).error, 'taken', 'nobody else can take it meanwhile');
  release();
  assert.equal((await booking).ok, true);
  assert.equal(holds.taken(SUN).get('k1').state, 'taken');
});

test('a payment that outlived payMs is paid but not booked, and says so with the ref', async () => {
  const now = clock();
  let release;
  const slow = { charge: () => new Promise((resolve) => (release = () => resolve({ ok: true, ref: 'late' }))) };
  const { store, reserve } = outfitter({ provider: slow, now, holdMs: 60_000, payMs: 120_000 });
  await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] });
  const booking = reserve.book('ada', 'b1', { method: CARD });
  await new Promise((resolve) => setTimeout(resolve, 5));
  now.add(121_000);
  release();
  assert.deepEqual(await booking, { error: 'lapsed-after-payment', key: 'b1', ref: 'late' });
  assert.equal(store.get('bookings', 'b1').reason, 'lapsed-after-payment');
  assert.equal(store.get('rentals', 'b1'), null, 'not started');
});

test('holding again with the same key moves the booking and lets go of days it dropped', async () => {
  const { holds, reserve } = outfitter();
  await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] });
  const moved = await reserve.hold('ada', { key: 'b1', pools: [SAT, SUN], units: ['k1'] });
  assert.equal(moved.cents, 10000);
  assert.equal(holds.taken(FRI).size, 0, 'Friday let go');
  assert.equal(holds.taken(SAT).get('k1').by, 'ada');
});

test('release lets go; other people and booked bookings are refused', async () => {
  const { holds, reserve } = outfitter();
  await reserve.hold('ada', { key: 'b1', pools: WEEKEND, units: ['k1'] });
  assert.deepEqual(await reserve.release('bo', 'b1'), { error: 'not-yours' });
  assert.deepEqual(await reserve.hold('bo', { key: 'b1', pools: WEEKEND, units: ['k2'] }), { error: 'not-yours' });
  assert.deepEqual(await reserve.release('ada', 'b1'), { ok: true });
  assert.equal(holds.taken(SAT).size, 0);
  assert.deepEqual(await reserve.book('ada', 'b1', { method: CARD }), { error: 'released' });
  await reserve.hold('ada', { key: 'b2', pools: [FRI], units: ['k1'] });
  await reserve.book('ada', 'b2', { method: CARD });
  assert.deepEqual(await reserve.hold('ada', { key: 'b2', pools: [FRI], units: ['k2'] }), { error: 'booked' });
  assert.deepEqual(await reserve.release('ada', 'b2'), { error: 'booked' });
});

test('refusals: no holder, no pools, no units, a bad count, no such booking', async () => {
  const { reserve } = outfitter();
  assert.deepEqual(await reserve.hold('', { pools: WEEKEND, units: ['k1'] }), { error: 'no-holder' });
  assert.deepEqual(await reserve.hold('ada', { pools: [], units: ['k1'] }), { error: 'no-pools' });
  assert.deepEqual(await reserve.hold('ada', { pools: WEEKEND, units: [] }), { error: 'no-units' });
  assert.deepEqual(await reserve.hold('ada', { pools: WEEKEND, count: 0, from: FLEET }), { error: 'bad-count' });
  assert.deepEqual(await reserve.book('ada', 'nope'), { error: 'no-booking' });
});

test("CineStack's seats: two seats at one showing, in the box office's own collections", async () => {
  const store = memoryStore();
  const seats = new Set(['A1', 'A2', 'A3']);
  const holds = createHolds({ store, max: 10, names: { units: 'seats', holders: 'holds', list: 'seats', taken: 'sold' } });
  const reserve = createReserve({
    store,
    holds,
    pay: createPay({ provider: testProvider(), store }),
    stages: createStages({ store, collection: 'tickets', steps: ['sold', 'scanned'], stamp: false }),
    base: 1100,
    rules: [{ label: 'Matinee', when: { time: { to: '17:00' } }, set: 750 }],
    context: () => ({ time: '14:30' }),
  });
  await holds.choose('bo', 'show-1930', { toggle: 'A3' }, { valid: seats });
  assert.deepEqual(await reserve.hold('ada', { key: 't1', pools: ['show-1930'], units: ['A2', 'A3'], valid: seats }), { error: 'taken', unit: 'A3', pool: 'show-1930' });
  assert.equal((await reserve.hold('ada', { key: 't1', pools: ['show-1930'], units: ['A4'], valid: seats })).error, 'unknown');
  const held = await reserve.hold('ada', { key: 't1', pools: ['show-1930'], units: ['A2', 'A1'], valid: seats });
  assert.deepEqual([held.units, held.cents], [['A1', 'A2'], 1500]);
  assert.equal((await reserve.book('ada', 't1', { method: CARD })).ok, true);
  assert.equal(store.get('seats', 'show-1930/A1').state, 'sold', "CineStack's seats document says sold");
  assert.deepEqual(store.get('holds', 'show-1930/ada').seats, []);
  assert.equal(store.get('tickets', 't1').status, 'sold');
});

test('states and days: plain data for a seat map and a day picker', async () => {
  const { holds, reserve } = outfitter();
  await holds.choose('bo', FRI, { units: ['k1'] });
  await reserve.hold('ada', { key: 'b1', pools: [FRI], units: ['k2'] });
  await reserve.hold('cy', { key: 'b2', pools: [SAT], units: ['k1'] });
  await reserve.book('cy', 'b2', { method: CARD });
  assert.deepEqual(reserve.states(FRI, ['k1', 'k2', 'k3'], 'ada'), [{ unit: 'k1', state: 'held' }, { unit: 'k2', state: 'mine' }, { unit: 'k3', state: 'free' }]);
  assert.deepEqual(reserve.states(FRI, ['k2'], 'bo'), [{ unit: 'k2', state: 'held' }], "someone else's hold");
  assert.deepEqual(reserve.states(SAT, ['k1']), [{ unit: 'k1', state: 'taken' }]);
  assert.deepEqual(reserve.days(WEEKEND, ['k1', 'k2', 'k3'], 'ada'), [
    { pool: FRI, free: 2, mine: true },
    { pool: SAT, free: 2, mine: false },
    { pool: SUN, free: 3, mine: false },
  ]);
});

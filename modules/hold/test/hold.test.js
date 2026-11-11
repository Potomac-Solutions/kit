import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, checkStore } from '../../store/index.js';
import { createHolds } from '../index.js';

const clock = (start = 1_000_000) => {
  let t = start;
  const now = () => t;
  now.add = (ms) => (t += ms);
  return now;
};
const SEATS = new Set(['A1', 'A2', 'A3', 'A10', 'B1']);

test('the memory store keeps the store contract', () => checkStore(memoryStore(), assert));

test('six holders ask for the same unit at once and exactly one gets it', async () => {
  const holds = createHolds({ store: memoryStore() });
  const answers = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((who) => holds.choose(who, 'show1', { toggle: 'A1' }, { valid: SEATS })));
  assert.equal(answers.filter((answer) => answer.ok).length, 1);
  assert.deepEqual(answers.filter((answer) => answer.error).map((answer) => [answer.error, answer.unit]), Array(5).fill(['taken', 'A1']));
  assert.equal(holds.taken('show1').get('A1').by, 'a');
});

test('a list is all or nothing', async () => {
  const store = memoryStore();
  const holds = createHolds({ store });
  await holds.choose('a', 'show1', { toggle: 'A2' });
  const answer = await holds.choose('b', 'show1', { units: ['A1', 'A2', 'A3'] });
  assert.deepEqual(answer, { error: 'taken', unit: 'A2' });
  assert.deepEqual([...holds.taken('show1').keys()], ['A2'], 'b got none of the three');
  assert.deepEqual(holds.held('b', 'show1'), { units: [], until: 0 });
});

test('toggle takes and lets go; a list replaces; units come back in natural order', async () => {
  const holds = createHolds({ store: memoryStore() });
  await holds.choose('a', 'p', { units: ['A10', 'B1', 'A2'] });
  assert.deepEqual(holds.held('a', 'p').units, ['A2', 'A10', 'B1']);
  assert.deepEqual((await holds.choose('a', 'p', { toggle: 'A10' })).units, ['A2', 'B1']);
  assert.deepEqual((await holds.choose('a', 'p', { units: ['A1'] })).units, ['A1']);
  assert.deepEqual([...holds.taken('p').keys()], ['A1'], 'the units it replaced are free again');
  assert.deepEqual((await holds.release('a', 'p')).units, []);
  assert.equal(holds.taken('p').size, 0);
});

test('unknown units, the limit and a missing holder are refused without writing', async () => {
  const store = memoryStore();
  const holds = createHolds({ store, max: 2 });
  assert.deepEqual(await holds.choose('a', 'p', { toggle: 'Z9' }, { valid: SEATS }), { error: 'unknown', unit: 'Z9' });
  assert.deepEqual(await holds.choose('a', 'p', { units: ['A1', 'nope'] }, { valid: (unit) => SEATS.has(unit) }), { error: 'unknown', unit: 'nope' });
  assert.deepEqual(await holds.choose('a', 'p', { units: ['A1', 'A2', 'A3'] }), { error: 'limit', max: 2, unit: undefined });
  assert.deepEqual(await holds.choose('', 'p', { toggle: 'A1' }), { error: 'no-holder' });
  assert.equal(store.under('units').length, 0);
});

test('a hold past its time counts as free at once, and the sweep tells everyone', async () => {
  const now = clock();
  const store = memoryStore();
  const holds = createHolds({ store, holdMs: 1000, now });
  await holds.choose('a', 'p', { units: ['A1', 'A2'] });
  now.add(999);
  assert.equal((await holds.choose('b', 'p', { toggle: 'A1' })).error, 'taken');
  assert.equal(await holds.sweep(), 0, 'nothing has lapsed yet');
  now.add(1);
  assert.equal(holds.taken('p').size, 0, 'free to a reader before any sweep');
  assert.equal(store.get('units', 'p/A1').state, 'held', 'the document still says held');
  assert.equal(await holds.sweep(), 2);
  assert.deepEqual(store.get('units', 'p/A1'), { state: 'free', by: '', until: 0 });
  assert.deepEqual(store.get('holds', 'p/a'), { units: [], until: 0 });
  assert.equal((await holds.choose('b', 'p', { toggle: 'A1' })).ok, true);
});

test('the sweep leaves a holder who chose again alone', async () => {
  const now = clock();
  const store = memoryStore();
  const holds = createHolds({ store, holdMs: 1000, now });
  await holds.choose('a', 'p', { toggle: 'A1' });
  // A stale document for the same holder, as if an old hold was never cleaned up.
  await store.write('units', 'p/B1', { state: 'held', by: 'a', until: now() - 1 });
  assert.equal(await holds.sweep(), 1);
  assert.deepEqual(store.get('holds', 'p/a').units, ['A1'], 'their live summary is not emptied');
});

test('choosing again restarts the clock unless there is a ceiling', async () => {
  const now = clock();
  const free = createHolds({ store: memoryStore(), holdMs: 1000, now });
  const capped = createHolds({ store: memoryStore(), holdMs: 1000, ceilingMs: 2500, now });
  const start = now();
  for (const holds of [free, capped]) await holds.choose('a', 'p', { toggle: 'A1' });
  now.add(900);
  for (const holds of [free, capped]) await holds.choose('a', 'p', { toggle: 'A2' });
  now.add(900);
  const [open, shut] = await Promise.all([free, capped].map((holds) => holds.choose('a', 'p', { toggle: 'A3' })));
  assert.equal(open.until, start + 1800 + 1000, 'no ceiling: five more minutes on every tap');
  assert.equal(shut.until, start + 2500, 'ceiling: counted from the first hold');
  now.add(700);
  assert.equal(capped.taken('p').size, 0, 'and it runs out then, however often they tapped');
  assert.equal((await capped.choose('a', 'p', { toggle: 'A1' })).until, now() + 1000, 'a fresh hold starts a fresh ceiling');
});

test('confirm turns holds into taken units that never lapse', async () => {
  const now = clock();
  const store = memoryStore();
  const holds = createHolds({ store, holdMs: 1000, now, names: { taken: 'sold' } });
  assert.deepEqual(await holds.confirm('a', 'p'), { error: 'nothing-held' });
  await holds.choose('a', 'p', { units: ['A1', 'A2'] });
  assert.deepEqual(await holds.confirm('a', 'p'), { ok: true, units: ['A1', 'A2'] });
  now.add(60_000);
  assert.equal(await holds.sweep(), 0);
  assert.equal(holds.taken('p').get('A1').state, 'sold');
  assert.equal((await holds.choose('b', 'p', { toggle: 'A1' })).error, 'taken');
  assert.deepEqual(holds.held('a', 'p'), { units: [], until: 0 }, 'sold units are no longer a hold');
});

test("names let an app keep its own collections and fields (CineStack's)", async () => {
  const store = memoryStore();
  const holds = createHolds({ store, names: { units: 'seats', holders: 'holds', list: 'seats', taken: 'sold' } });
  const { until } = await holds.choose('guest', 'show1', { toggle: 'C8' });
  assert.deepEqual(store.get('seats', 'show1/C8'), { state: 'held', by: 'guest', until });
  assert.deepEqual(store.get('holds', 'show1/guest'), { seats: ['C8'], until });
});

test('pools are separate', async () => {
  const holds = createHolds({ store: memoryStore() });
  await holds.choose('a', 'sat', { toggle: 'kayak-12' });
  assert.equal((await holds.choose('b', 'sun', { toggle: 'kayak-12' })).ok, true);
  assert.equal(holds.taken('sat').get('kayak-12').by, 'a');
});

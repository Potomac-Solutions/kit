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
  const holds = createHolds({ store, holdMs: 1000, ceilingMs: 0, now });
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
  const holds = createHolds({ store, ceilingMs: 0, names: { units: 'seats', holders: 'holds', list: 'seats', taken: 'sold' } });
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

const DAYS = ['kayaks/2026-11-20', 'kayaks/2026-11-21', 'kayaks/2026-11-22'];
const across = (units) => DAYS.map((pool) => ({ pool, units }));

test('chooseAcross: every pool or none, and a refusal names the pool', async () => {
  const holds = createHolds({ store: memoryStore() });
  await holds.choose('bo', DAYS[2], { units: ['k1'] });
  assert.deepEqual(await holds.chooseAcross('ada', across(['k1'])), { error: 'taken', unit: 'k1', pool: DAYS[2] });
  assert.equal(holds.taken(DAYS[0]).size, 0, 'Friday was not held either');
  const answer = await holds.chooseAcross('ada', across(['k2']));
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.pools.map((p) => p.units), [['k2'], ['k2'], ['k2']]);
  assert.deepEqual(DAYS.map((pool) => holds.held('ada', pool).units), [['k2'], ['k2'], ['k2']]);
});

test('chooseAcross: two holders for the last kayak on overlapping days, exactly one gets it', async () => {
  const holds = createHolds({ store: memoryStore() });
  const [ada, bo] = await Promise.all([holds.chooseAcross('ada', across(['k1']).slice(0, 2)), holds.chooseAcross('bo', across(['k1']).slice(1))]);
  assert.equal([ada, bo].filter((a) => a.ok).length, 1);
  assert.equal(holds.taken(DAYS[2]).size, 0, 'the loser held nothing, Sunday included');
});

test('chooseAcross checks units per pool, and refuses nothing to choose and no holder', async () => {
  const holds = createHolds({ store: memoryStore(), max: 2 });
  const valid = (unit, pool) => !(pool === DAYS[1] && unit === 'k3');
  assert.deepEqual(await holds.chooseAcross('ada', across(['k3']), { valid }), { error: 'unknown', unit: 'k3', pool: DAYS[1] });
  assert.equal((await holds.chooseAcross('ada', across(['k1', 'k2', 'k3']))).error, 'limit');
  assert.deepEqual(await holds.chooseAcross('ada', []), { error: 'nothing' });
  assert.deepEqual(await holds.chooseAcross('', across(['k1'])), { error: 'no-holder' });
});

test('chooseAcross with ms holds longer, past the ceiling', async () => {
  const now = clock();
  const holds = createHolds({ store: memoryStore(), holdMs: 60_000, ceilingMs: 90_000, now });
  await holds.chooseAcross('ada', across(['k1']));
  now.add(50_000);
  const normal = await holds.chooseAcross('ada', across(['k1']));
  assert.equal(normal.until, now() - 50_000 + 90_000, 'the ceiling cuts a normal choice');
  const paying = await holds.chooseAcross('ada', across(['k1']), { ms: 120_000 });
  assert.equal(paying.until, now() + 120_000, 'a payment window is not cut');
});

test('confirm with units takes only those, only while held, and keeps the rest held', async () => {
  const now = clock();
  const store = memoryStore();
  const holds = createHolds({ store, now });
  await holds.choose('ada', 'show1', { units: ['A1', 'A2', 'A3'] });
  assert.deepEqual(await holds.confirm('ada', 'show1', ['A1', 'B1']), { error: 'not-held', units: ['B1'] });
  assert.equal(holds.taken('show1').get('A1').state, 'held', 'nothing confirmed');
  assert.deepEqual(await holds.confirm('ada', 'show1', ['A2', 'A1']), { ok: true, units: ['A1', 'A2'] });
  assert.equal(holds.taken('show1').get('A1').state, 'taken');
  assert.deepEqual(holds.held('ada', 'show1').units, ['A3'], 'the rest stay held');
  assert.deepEqual(store.get('holds', 'show1/ada').units, ['A3'], "the holder's summary still lists the rest");
  now.add(holds.holdMs);
  assert.deepEqual(await holds.confirm('ada', 'show1', ['A3']), { error: 'not-held', units: ['A3'] }, 'a lapsed hold cannot be confirmed');
});

test("a deeper pool's units aren't this pool's, and a unit can't name one", async () => {
  const store = memoryStore();
  const holds = createHolds({ store });
  await holds.confirm('ada', 'kayaks/sat', ['k1']).catch(() => {});
  await holds.choose('ada', 'kayaks/sat', { units: ['k1'] });
  await holds.confirm('ada', 'kayaks/sat');
  assert.equal((await holds.choose('mal', 'kayaks/sat/k1x', { units: ['k1'] })).ok, true);
  assert.deepEqual(holds.taken('kayaks/sat').get('k1'), { state: 'taken', by: 'ada', until: 0 }, 'still the paid unit');
  assert.deepEqual(await holds.choose('mal', 'kayaks/sat', { toggle: 'k1' }), { error: 'taken', unit: 'k1' });
  assert.deepEqual(await holds.choose('mal', 'kayaks', { units: ['sat/k2'] }), { error: 'unknown', unit: 'sat/k2' });
});

test('a payment window runs past the ceiling once, not again and again', async () => {
  const now = clock();
  const holds = createHolds({ store: memoryStore(), holdMs: 60_000, ceilingMs: 10 * 60_000, now });
  await holds.choose('mal', 'p', { units: ['A1'] });
  let last;
  for (let i = 0; i < 12; i++) {
    last = await holds.chooseAcross('mal', [{ pool: 'p', units: ['A1'] }], { ms: 2 * 60_000 });
    assert.ok(last.until <= 1_000_000 + 12 * 60_000);
    now.add(60_000);
  }
  assert.equal(last.until, 1_000_000 + 12 * 60_000, 'ceiling plus one payment window');
  assert.deepEqual(holds.held('mal', 'p').units, [], 'lapsed at 12 minutes, retries or not');
});

test('by default one holder holds at most 8 and not forever', async () => {
  const now = clock();
  const holds = createHolds({ store: memoryStore(), now });
  const all = Array.from({ length: 9 }, (_, i) => `u${i}`);
  assert.equal((await holds.choose('mal', 'p', { units: all })).error, 'limit');
  await holds.choose('mal', 'p', { units: all.slice(0, 8) });
  for (let i = 0; i < 4; i++) {
    now.add(4 * 60_000);
    await holds.choose('mal', 'p', { units: all.slice(0, 8) });
  }
  now.add(4 * 60_000);
  assert.deepEqual(holds.held('mal', 'p').units, [], 'the 20-minute ceiling let them go');
});

test('free gives taken units back for good: only the holder’s own, all or nothing', async () => {
  const store = memoryStore();
  const holds = createHolds({ store });
  await holds.choose('a', 'p', { units: ['A1', 'A2', 'A3'] });
  await holds.confirm('a', 'p', ['A1', 'A2']);
  await holds.choose('b', 'p', { units: ['B1'] });
  await holds.confirm('b', 'p');
  assert.deepEqual(await holds.free('a', 'p', ['A1', 'B1']), { error: 'not-yours', units: ['B1'] });
  assert.deepEqual(await holds.free('a', 'p', ['A10']), { error: 'not-yours', units: ['A10'] }, 'a free unit is nobody’s');
  assert.deepEqual([...holds.taken('p').keys()], ['A1', 'A2', 'A3', 'B1'], 'nothing changed');
  assert.deepEqual(await holds.free('a', 'p', ['A2']), { ok: true, units: ['A2'] });
  assert.deepEqual([...holds.taken('p').keys()], ['A1', 'A3', 'B1']);
  assert.equal(holds.held('a', 'p').units.join(), 'A3', 'the still-held unit is untouched');
  // Someone else can have it now.
  assert.equal((await holds.choose('c', 'p', { toggle: 'A2' })).ok, true);
  // Freeing a held unit takes it out of the holder's summary too.
  assert.deepEqual(await holds.free('a', 'p', ['A3']), { ok: true, units: ['A3'] });
  assert.deepEqual(holds.held('a', 'p'), { units: [], until: 0 });
  assert.deepEqual(store.get('holds', 'p/a').units, []);
  assert.deepEqual(await holds.free('a', 'p', []), { error: 'nothing' });
  assert.deepEqual(await holds.free('', 'p', ['A1']), { error: 'no-holder' });
});

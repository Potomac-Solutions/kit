import { test } from 'node:test';
import assert from 'node:assert/strict';
import { price, checkRules, moment } from '../index.js';

// An example cinema's prices. The numbers are made up for the test; they are not any real theatre's.
const ADULT = 1100;
const rules = checkRules([
  { label: 'Child, senior, military', when: { ticket: ['child', 'senior', 'military'] }, set: 900 },
  { label: 'Matinee', when: { time: { to: '17:00' } }, set: 800 },
  { label: 'Discount Tuesday', when: { day: 2 }, set: 600 },
  { label: '3D', when: { format: '3d' }, add: 300 },
  { label: 'Member', when: { member: true }, percent: -10 },
]);
const cents = (context) => price(ADULT, rules, context).cents;

test('one rule list gives every published price', () => {
  assert.equal(cents({ ticket: 'adult', day: 5, time: '19:30' }), 1100, 'adult evening');
  assert.equal(cents({ ticket: 'child', day: 5, time: '19:30' }), 900, 'child evening');
  assert.equal(cents({ ticket: 'adult', day: 6, time: '13:15' }), 800, 'adult matinee');
  assert.equal(cents({ ticket: 'child', day: 6, time: '13:15' }), 800, 'the matinee price is for everyone');
  assert.equal(cents({ ticket: 'adult', day: 2, time: '19:30' }), 600, 'discount day');
  assert.equal(cents({ ticket: 'adult', day: 2, time: '19:30', format: '3d' }), 900, 'the surcharge still applies on discount day');
  assert.equal(cents({ ticket: 'adult', day: 5, time: '19:30', format: '3d', member: true }), 1260, 'surcharge, then the member discount');
});

test('the answer says which rules applied', () => {
  assert.deepEqual(price(ADULT, rules, { ticket: 'senior', day: 2, time: '14:00', format: '3d' }), { cents: 900, applied: ['Child, senior, military', 'Matinee', 'Discount Tuesday', '3D'] });
  assert.deepEqual(price(ADULT, rules, {}), { cents: 1100, applied: [] });
});

test('ranges include their start and stop before their end', () => {
  assert.equal(cents({ time: '16:59' }), 800);
  assert.equal(cents({ time: '17:00' }), 1100);
  const season = [{ when: { date: { from: '2026-12-19', to: '2027-01-04' } }, percent: 25 }];
  assert.equal(price(4000, season, { date: '2026-12-18' }).cents, 4000);
  assert.equal(price(4000, season, { date: '2026-12-19' }).cents, 5000);
  assert.equal(price(4000, season, { date: '2027-01-04' }).cents, 4000);
  assert.equal(price(4000, season, {}).cents, 4000, 'a range never matches a missing value');
});

test('duration pricing for a rental is the same function', () => {
  const kayak = [
    { label: 'Half day', when: { hours: { from: 3, to: 6 } }, set: 4500 },
    { label: 'Full day', when: { hours: { from: 6 } }, set: 6500 },
    { label: 'Weekend', when: { day: [0, 6] }, add: 500 },
  ];
  assert.equal(price(2500, kayak, { hours: 2, day: 3 }).cents, 2500);
  assert.equal(price(2500, kayak, { hours: 4, day: 3 }).cents, 4500);
  assert.equal(price(2500, kayak, { hours: 8, day: 6 }).cents, 7000);
});

test('a price never goes below zero, and percentages round to the cent', () => {
  assert.equal(price(500, [{ add: -900 }]).cents, 0);
  assert.equal(price(999, [{ percent: -15 }]).cents, 849);
});

test('malformed rules and prices are refused', () => {
  assert.throws(() => checkRules([{ when: {} }]), /exactly one/);
  assert.throws(() => checkRules([{ set: 100, add: 50 }]), /exactly one/);
  assert.throws(() => checkRules([{ set: 9.5 }]), /whole cents/);
  assert.throws(() => checkRules([{ set: -1 }]), /negative/);
  assert.throws(() => checkRules([{ add: 100, when: ['day'] }]), /object/);
  assert.throws(() => price(10.5), /whole cents/);
});

test('moment() reads the clock where the business is, not where the server is', () => {
  // 00:30 UTC on Wednesday 11 November 2026 is still Tuesday evening in Maryland.
  const instant = new Date('2026-11-11T00:30:00Z');
  assert.deepEqual(moment(instant, 'America/New_York'), { day: 2, time: '19:30', date: '2026-11-10' });
  assert.deepEqual(moment(instant, 'UTC'), { day: 3, time: '00:30', date: '2026-11-11' });
  assert.equal(cents({ ticket: 'adult', ...moment(instant, 'America/New_York') }), 600);
});

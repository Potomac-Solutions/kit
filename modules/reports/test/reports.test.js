import { test } from 'node:test';
import assert from 'node:assert/strict';
import { series, totals, breakdown, csv } from '../index.js';

const at = (text) => Date.parse(text);

test('days are calendar days in the zone, with empty days listed', () => {
  const orders = [
    { paid: at('2026-11-02T03:30:00Z'), cents: 100 }, // 22:30 on Nov 1 in New York
    { paid: at('2026-11-02T15:00:00Z'), cents: 250 },
    { paid: at('2026-11-04T15:00:00Z'), cents: 50 },
  ];
  const days = series(orders, { at: (o) => o.paid, amount: (o) => o.cents, zone: 'America/New_York', from: at('2026-11-01T12:00:00Z'), to: at('2026-11-04T20:00:00Z') });
  assert.deepEqual(days, [
    { start: '2026-11-01', count: 1, amount: 100 },
    { start: '2026-11-02', count: 1, amount: 250 },
    { start: '2026-11-03', count: 0, amount: 0 },
    { start: '2026-11-04', count: 1, amount: 50 },
  ]);
});

test('weeks start on Monday and months on the 1st; out-of-range and missing times are left out', () => {
  const records = [at('2026-11-15T12:00:00Z'), at('2026-11-16T12:00:00Z'), at('2026-12-01T12:00:00Z'), at('2027-01-01T12:00:00Z'), null];
  const from = at('2026-11-10T00:00:00Z');
  const to = at('2026-12-31T00:00:00Z');
  const weeks = series(records, { at: (r) => r, from, to, by: 'week' });
  assert.equal(weeks[0].start, '2026-11-09');
  assert.deepEqual(weeks.slice(0, 2).map((w) => w.count), [1, 1]);
  assert.ok(weeks.every((w) => new Date(`${w.start}T00:00:00Z`).getUTCDay() === 1));
  assert.deepEqual(series(records, { at: (r) => r, from, to, by: 'month' }), [
    { start: '2026-11-01', count: 2, amount: 0 },
    { start: '2026-12-01', count: 1, amount: 0 },
  ]);
});

test('a daylight saving change does not split or skip a day', () => {
  const days = series([], { at: (r) => r, zone: 'America/New_York', from: at('2026-10-31T12:00:00Z'), to: at('2026-11-02T12:00:00Z') });
  assert.deepEqual(days.map((d) => d.start), ['2026-10-31', '2026-11-01', '2026-11-02']);
});

test('series refuses a bad request', () => {
  assert.throws(() => series([], { from: 0, to: 1 }), /at\(record\)/);
  assert.throws(() => series([], { at: () => 0, by: 'year', from: 0, to: 1 }), /by is/);
  assert.throws(() => series([], { at: () => 0, from: 2, to: 1 }), /from <= to/);
  assert.throws(() => series([], { at: () => 0, zone: 'Not/AZone', from: 0, to: 1 }));
  assert.throws(() => series([], { at: () => 0, from: 0, to: 20_000 * 86_400_000 }), /5000 buckets/);
});

test('totals and breakdown', () => {
  const rows = [{ kind: 'kayak', cents: 3000 }, { kind: 'bike', cents: 2000 }, { kind: 'kayak', cents: 3000 }, { kind: 'sup', cents: 'x' }];
  assert.deepEqual(totals(rows, { amount: (r) => r.cents }), { count: 4, amount: 8000 });
  assert.deepEqual(breakdown(rows, { key: (r) => r.kind, amount: (r) => r.cents }), [
    { key: 'kayak', count: 2, amount: 6000 },
    { key: 'bike', count: 1, amount: 2000 },
    { key: 'sup', count: 1, amount: 0 },
  ]);
});

test('csv quotes what needs quoting and defuses formulas', () => {
  const text = csv(
    [
      { name: 'Ann, "the boss"', note: '=HYPERLINK("x")', cents: 1250 },
      { name: 'Line\nbreak', note: '-2', cents: null },
    ],
    [{ key: 'name', label: 'Name' }, { key: 'note', label: 'Note' }, { key: 'cents', label: 'Dollars', value: (r) => (r.cents == null ? null : r.cents / 100) }],
  );
  assert.equal(text, 'Name,Note,Dollars\r\n"Ann, ""the boss""","\'=HYPERLINK(""x"")",12.5\r\n"Line\nbreak",\'-2,\r\n');
  assert.throws(() => csv([], []), /columns/);
});

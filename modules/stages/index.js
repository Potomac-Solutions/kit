// stages: move a record through named steps.
//
// Extracted from Tailgate's market (src/market.js, fc0f6ae): an order is placed, a driver claims
// it, picks it up, delivers it. A taxidermist's job tag and a pickup queue are the same thing with
// other step names.
//
//   <collection>/<key>   { <field>: <step>, <owner>: <who>, <step>: <when>, ...the app's own fields }
//
// Only the server writes these, and nothing awaits between a check and its write, so a step can't
// be taken twice and a claim has exactly one winner.
//
// Answers are `{ ok: true, ... }` or `{ error: <code>, ... }`. The app chooses the words.

export function createStages({
  store,
  collection,
  steps,
  field = 'status',
  // The field that says whose record this is once someone claims it ('driver', 'tech'). Optional.
  owner = '',
  // Steps reachable from somewhere other than the step before them: { cancelled: ['placed', 'claimed'] }.
  from = {},
  // Record when each step was reached, in a field named after the step. true, false, or a list of steps.
  stamp = true,
  // Who may advance. By default only the owner, and only along `steps`: side steps (cancel,
  // refund) and records with no `owner` option need the app's own `may`.
  may = ({ record, to, by }) => Boolean(by) && steps.includes(to) && record[owner] === by,
  now = Date.now,
} = {}) {
  if (!store || !collection) throw new TypeError('createStages needs a store and a collection');
  if (!Array.isArray(steps) || steps.length < 2) throw new TypeError('createStages needs at least two steps');
  const known = new Set([...steps, ...Object.keys(from)]);
  const stamped = (step, at) => (stamp === true || (Array.isArray(stamp) && stamp.includes(step)) ? { [step]: at } : {});
  const allowedFrom = (to) => from[to] ?? (steps.indexOf(to) > 0 ? [steps[steps.indexOf(to) - 1]] : []);

  return {
    steps,
    /** The step a record is at, or null. */
    at: (key) => store.get(collection, key)?.[field] ?? null,

    /** Begin a record at the first step. */
    async start(key, fields = {}) {
      if (store.get(collection, key)) return { error: 'exists' };
      await store.write(collection, key, { ...fields, [field]: steps[0], ...stamped(steps[0], now()) });
      return { ok: true, at: steps[0] };
    },

    /** Take an unowned record and move it to the second step. Exactly one claimant wins. */
    async claim(key, who, set = {}) {
      if (!owner) throw new TypeError('claim() needs the `owner` option');
      if (!who) return { error: 'no-claimant' };
      const record = store.get(collection, key);
      if (!record) return { error: 'missing' };
      if (record[owner]) return { error: 'claimed', by: record[owner], yours: record[owner] === who };
      if (record[field] !== steps[0]) return { error: 'wrong-step', at: record[field] };
      await store.write(collection, key, { ...set, [owner]: who, [field]: steps[1], ...stamped(steps[1], now()) });
      return { ok: true, at: steps[1] };
    },

    /** Move a record to `to`. It must be at a step `to` can follow, and `by` must be allowed. */
    async advance(key, to, { by, set = {} } = {}) {
      if (!known.has(to) || to === steps[0]) return { error: 'unknown-step', to };
      const record = store.get(collection, key);
      if (!record) return { error: 'missing' };
      if (!may({ record, to, by })) return { error: 'refused' };
      if (!allowedFrom(to).includes(record[field])) return { error: 'wrong-step', at: record[field] };
      await store.write(collection, key, { ...set, [field]: to, ...stamped(to, now()) });
      return { ok: true, at: to };
    },
  };
}

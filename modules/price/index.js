// price: turn an item and a context into a price.
//
// A pure function. No database, no clock, no currency formatting. Money is whole cents.
//
// Rules run in order. Each has a `when` (all of its keys must match the context) and exactly one
// of `set`, `add` or `percent`:
//
//   { label: 'Child',     when: { ticket: 'child' },                      set: 800 }
//   { label: 'Matinee',   when: { time: { to: '17:00' } },                set: 750 }
//   { label: 'Tuesday',   when: { day: 2 },                               set: 600 }
//   { label: '3D',        when: { format: '3d' },                         add: 300 }
//   { label: 'Member',    when: { member: true },                         percent: -10 }
//
// A `when` value is a plain value (equal), a list (any of), or `{ from, to }` (from inclusive, to
// exclusive; numbers, or strings that sort in order such as '17:00' and '2026-12-24').
// A later rule sees the result of the earlier ones, so order is the policy: put what replaces the
// price first and what adjusts it after.

function test(want, have) {
  if (Array.isArray(want)) return want.some((one) => test(one, have));
  if (want && typeof want === 'object') {
    if (have === undefined || have === null) return false;
    return (want.from === undefined || have >= want.from) && (want.to === undefined || have < want.to);
  }
  return have === want;
}

const KINDS = ['set', 'add', 'percent'];

/** Throw if a rule list is malformed. Run it when rules are saved, not on every price. */
export function checkRules(rules) {
  if (!Array.isArray(rules)) throw new TypeError('Price rules must be a list');
  rules.forEach((rule, i) => {
    const kinds = KINDS.filter((kind) => rule?.[kind] !== undefined);
    if (kinds.length !== 1) throw new TypeError(`Price rule ${i + 1} needs exactly one of set, add or percent`);
    const amount = rule[kinds[0]];
    if (kinds[0] === 'percent' ? !Number.isFinite(amount) : !Number.isInteger(amount)) throw new TypeError(`Price rule ${i + 1}: ${kinds[0]} must be ${kinds[0] === 'percent' ? 'a number' : 'whole cents'}`);
    if (kinds[0] === 'set' && amount < 0) throw new TypeError(`Price rule ${i + 1}: set can't be negative`);
    if (rule.when !== undefined && (typeof rule.when !== 'object' || rule.when === null || Array.isArray(rule.when))) throw new TypeError(`Price rule ${i + 1}: when must be an object`);
  });
  return rules;
}

/** The price in cents for `base` under `rules` in `context`, and the labels of the rules that applied. */
export function price(base, rules = [], context = {}) {
  if (!Number.isInteger(base) || base < 0) throw new TypeError('A base price is whole cents, zero or more');
  let cents = base;
  const applied = [];
  for (const rule of rules) {
    if (!Object.entries(rule.when ?? {}).every(([key, want]) => test(want, context[key]))) continue;
    if (rule.set !== undefined) cents = rule.set;
    else if (rule.add !== undefined) cents += rule.add;
    else cents = Math.round(cents * (1 + rule.percent / 100));
    applied.push(rule.label ?? '');
  }
  return { cents: Math.max(0, cents), applied };
}

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The parts of a moment that rules ask about, on the business's own clock:
 * `{ day: 0-6 (Sunday is 0), time: 'HH:MM', date: 'YYYY-MM-DD' }`.
 */
export function moment(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { day: DAYS[parts.weekday], time: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

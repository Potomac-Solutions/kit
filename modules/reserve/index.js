// reserve: book a unit, or several, for a stretch of pools, all or nothing.
//
// Built on `hold` (CineStack's box office), `price`, `pay` and `stages`. A *pool* is one stretch
// people compete for: a rental day (`kayaks/2026-11-20`), a showing, a tour departure. A booking
// is the same units in every pool it names: kayak 12 Friday, Saturday and Sunday, or seats A1 and
// A2 at the 7:00 showing.
//
//   1. `hold` holds the units in every pool or none (`hold.chooseAcross`), and keeps a draft:
//      what's held, and the price shown for it. With `count` instead of `units`, it picks units
//      free in every pool (the same kayak all weekend), in order.
//   2. `book` checks every hold is still live, holds them through the payment (`payMs`), charges
//      the price shown, once, keyed by the booking, then confirms the units in every pool and
//      starts the booking at its first step. Declined: nothing is confirmed, the holds run out on
//      their own, and it can be tried again while they last.
//
//   <collection>/<key>   { holder, pools, units, lines, cents, state, until, ref, reason, at }
//   state: 'held' | 'pending' | 'paid' | 'failed' | 'released'
//
// What a holder holds in a pool is one list, so a second draft of theirs in the same pool
// replaces the first there. `key` comes from the page (a hidden field), like checkout's.
//
// Answers are `{ ok: true, ... }` or `{ error: <code>, ... }`. The app chooses the words.

import { price as priceOf } from '../price/index.js';

const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const newKey = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createReserve({
  store,
  holds,
  pay,
  stages,
  collection = 'bookings',
  // A unit's price for one pool, in cents: a number for all, or (unit, pool) => cents.
  base,
  rules = [],
  // What the price rules see for a pool besides `pool` and `unit` (the day, from `price.moment`).
  context = () => ({}),
  // How long the holds are kept while the payment is out. Longer than any provider takes.
  payMs = 2 * 60_000,
  now = Date.now,
} = {}) {
  if (!store || !holds || !pay || !stages) throw new TypeError('createReserve needs a store, holds, pay and stages');
  if (base === undefined) throw new TypeError('createReserve needs a base price');
  const baseOf = typeof base === 'function' ? base : () => base;

  /** What `units` in every one of `pools` would cost, line by line. Writes nothing. */
  function quote({ pools = [], units = [] } = {}) {
    const lines = [];
    for (const pool of pools) {
      for (const unit of units) {
        const cents = baseOf(unit, pool);
        if (!Number.isInteger(cents) || cents < 0) throw new TypeError(`No price for ${unit} in ${pool}`);
        const priced = priceOf(cents, rules, { ...context(pool), pool, unit });
        lines.push({ pool, unit, base: cents, cents: priced.cents, applied: priced.applied });
      }
    }
    return { lines, cents: lines.reduce((sum, line) => sum + line.cents, 0) };
  }

  /** Of `candidates`, the units free in every one of `pools` (or held by `holder`), in order. */
  function free(pools, candidates, holder = '') {
    const busy = pools.map((pool) => holds.taken(pool));
    return [...candidates]
      .map(String)
      .filter((unit) => busy.every((taken) => !taken.has(unit) || (holder && taken.get(unit).state === 'held' && taken.get(unit).by === holder)))
      .sort(natural);
  }

  const refuseFor = (booking, holder) => {
    if (!booking) return null;
    if (booking.holder !== holder) return { error: 'not-yours' };
    if (booking.state === 'paid') return { error: 'booked' };
    if (booking.state === 'pending') return { error: 'in-progress' };
    return null;
  };

  /**
   * For a picture of one pool (a seat map): each of `units` as `free`, `mine` (held by
   * `holder`), `held` (by someone else) or `taken`. Plain data for a component.
   */
  function states(pool, units, holder = '') {
    const busy = holds.taken(pool);
    return [...units].map(String).map((unit) => {
      const now = busy.get(unit);
      if (!now) return { unit, state: 'free' };
      if (now.state === 'held') return { unit, state: holder && now.by === holder ? 'mine' : 'held' };
      return { unit, state: 'taken' };
    });
  }

  /** For a picture of several pools (a day picker): how many of `units` are free in each, and whether `holder` holds any there. */
  function days(pools, units, holder = '') {
    return pools.map(String).map((pool) => {
      const each = states(pool, units, holder);
      return { pool, free: each.filter((one) => one.state === 'free' || one.state === 'mine').length, mine: each.some((one) => one.state === 'mine') };
    });
  }

  return {
    quote,
    free,
    states,
    days,

    /** A booking as it stands, or null. */
    get: (key) => store.get(collection, key),

    /**
     * Hold `units` (or `count` of `from`) in every one of `pools`, and keep the draft. Holding
     * again with the same key changes it: pools it no longer names are let go.
     */
    async hold(holder, { key = newKey(), pools = [], units, count, from, valid } = {}) {
      if (!holder) return { error: 'no-holder' };
      pools = [...new Set(pools.map(String))];
      if (!pools.length) return { error: 'no-pools' };
      const before = store.get(collection, key);
      const refused = refuseFor(before, holder);
      if (refused) return refused;

      if (count !== undefined) {
        if (!Number.isInteger(count) || count < 1) return { error: 'bad-count' };
        if (!from) throw new TypeError('hold with count needs `from`, the units to pick among');
        const open = free(pools, from, holder);
        if (open.length < count) return { error: 'none-free', left: open.length };
        units = open.slice(0, count);
      }
      units = [...new Set((units ?? []).map(String))].sort(natural);
      if (!units.length) return { error: 'no-units' };

      const dropped = (before?.state === 'held' || before?.state === 'failed' ? before.pools : []).filter((pool) => !pools.includes(pool));
      const held = await holds.chooseAcross(holder, [...pools.map((pool) => ({ pool, units })), ...dropped.map((pool) => ({ pool, units: [] }))], { valid });
      if (held.error) return held;

      const { lines, cents } = quote({ pools, units });
      await store.write(collection, key, { holder, pools, units, lines, cents, state: 'held', until: held.until, ref: '', reason: '', at: now() });
      return { ok: true, key, pools, units, lines, cents, until: held.until };
    },

    /**
     * Pay for a held booking and confirm it. `method` goes to the provider and is never stored;
     * `fields` go on the booking's record in `stages` (a name, a phone number).
     */
    async book(holder, key, { method, fields = {}, description = '' } = {}) {
      if (!holder) return { error: 'no-holder' };
      const booking = store.get(collection, key);
      if (!booking) return { error: 'no-booking' };
      if (booking.holder !== holder) return { error: 'not-yours' };
      if (booking.state === 'paid') return { ok: true, again: true, key, ref: booking.ref, cents: booking.cents };
      if (booking.state === 'pending') return { error: 'in-progress' };
      if (booking.state === 'released') return { error: 'released' };

      // Every hold still live, then all of them kept through the payment, before any await.
      const mine = booking.pools.map((pool) => ({ pool, units: holds.held(holder, pool).units }));
      for (const { pool, units } of mine) {
        const lost = booking.units.filter((unit) => !units.includes(unit));
        if (lost.length) return { error: 'lapsed', pool, units: lost };
      }
      const kept = holds.chooseAcross(holder, mine, { ms: payMs });
      const pending = store.write(collection, key, { state: 'pending', reason: '', at: now() });
      const [extended] = await Promise.all([kept, pending]);
      if (extended.error) {
        await store.write(collection, key, { state: 'held', at: now() });
        return extended;
      }

      const paid = await pay.pay({ id: key, cents: booking.cents, method, description });
      if (!paid.ok) {
        await store.write(collection, key, { state: 'failed', reason: paid.error, at: now() });
        return { error: paid.error, key };
      }

      // Paid. Confirm the units in every pool; one lost now means the payment outlived `payMs`.
      const confirmed = [];
      for (const pool of booking.pools) confirmed.push(await holds.confirm(holder, pool, booking.units));
      const lost = confirmed.find((answer) => answer.error);
      if (lost) {
        await store.write(collection, key, { state: 'paid', ref: paid.ref, reason: 'lapsed-after-payment', at: now() });
        return { error: 'lapsed-after-payment', key, ref: paid.ref };
      }
      await Promise.all([
        stages.start(key, { ...fields, holder, pools: booking.pools, units: booking.units, lines: booking.lines, cents: booking.cents }),
        store.write(collection, key, { state: 'paid', ref: paid.ref, until: 0, at: now() }),
      ]);
      return { ok: true, key, ref: paid.ref, cents: booking.cents };
    },

    /** Let go of a held booking's units. */
    async release(holder, key) {
      const booking = store.get(collection, key);
      if (!booking) return { error: 'no-booking' };
      const refused = refuseFor(booking, holder);
      if (refused) return refused;
      if (booking.state === 'released') return { ok: true };
      await holds.chooseAcross(holder, booking.pools.map((pool) => ({ pool, units: holds.held(holder, pool).units.filter((unit) => !booking.units.includes(unit)) })));
      await store.write(collection, key, { state: 'released', until: 0, at: now() });
      return { ok: true };
    },
  };
}

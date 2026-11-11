// hold: reserve one contested thing for a window of time.
//
// Extracted from CineStack's box office (src/box-office.js, 1c17019), with the cinema taken out.
// A *pool* is what people compete inside (a showing, a tour departure, a rental day). A *unit* is
// one thing in it (a seat, a place, kayak 12). A *holder* is whoever is asking, by a name that is
// safe to show other people.
//
// Nobody but the server writes these documents, so two people can't both get a unit:
//
//   <units>/<pool>/<unit>      { state: 'held' | <taken> | 'free', by, until }
//   <holders>/<pool>/<holder>  { <list>: [...], until }     the holder's own summary
//
// Answers are `{ ok: true, ... }` or `{ error: <code>, ... }`. The app chooses the words.

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export function createHolds({
  store,
  holdMs = 5 * 60_000,
  // The longest a holder can keep units by choosing again and again, counted from their first
  // hold. 0 means no ceiling (each choice restarts the clock, as the CineStack spike did).
  ceilingMs = 0,
  max = Infinity,
  sweepMs = 0,
  names = {},
  order = natural,
  now = Date.now,
} = {}) {
  if (!store) throw new TypeError('createHolds needs a store');
  const N = { units: 'units', holders: 'holds', list: 'units', taken: 'taken', ...names };
  const FREE = { state: 'free', by: '', until: 0 };

  const unitOf = (key) => key.slice(key.lastIndexOf('/') + 1);
  const poolOf = (key) => key.slice(0, key.lastIndexOf('/'));
  /** A unit document as it stands now: a hold past its time counts as free. */
  const current = (doc, at) =>
    doc?.state === 'held' && doc.until <= at ? FREE : { state: doc?.state ?? 'free', by: doc?.by ?? '', until: doc?.until ?? 0 };

  /** Every unit of a pool that isn't free, by unit id. */
  function taken(pool, at = now()) {
    const units = new Map();
    for (const doc of store.under(N.units, `${pool}/`)) {
      const unit = current(doc, at);
      if (unit.state !== 'free') units.set(unitOf(doc.key), unit);
    }
    return units;
  }

  const mineIn = (units, holder) => [...units].filter(([, unit]) => unit.state === 'held' && unit.by === holder).map(([id]) => id);

  /** A holder's units in a pool, and when the hold runs out. */
  function held(holder, pool, at = now()) {
    const units = taken(pool, at);
    const mine = mineIn(units, holder).sort(order);
    return { units: mine, until: mine.length ? Math.max(...mine.map((id) => units.get(id).until)) : 0 };
  }

  const summary = (list, until, since) => ({ [N.list]: list, until, ...(ceilingMs ? { since } : {}) });

  /**
   * A holder chooses units. With `toggle`, that one unit is taken or let go. With `units`, the
   * holder's units become exactly that list. All or nothing: if any unit they want has gone,
   * nothing changes. `valid` (a Set, or a function) says which unit ids exist in this pool.
   *
   * Nothing here awaits before the writes are stored, so two holders asking for the same unit
   * can't both get it.
   */
  async function choose(holder, pool, { toggle, units } = {}, { valid } = {}) {
    if (!holder) return { error: 'no-holder' };
    const exists = (unit) => !valid || (typeof valid === 'function' ? valid(unit) : valid.has(unit));
    const at = now();
    const all = taken(pool, at);
    const mine = new Set(mineIn(all, holder));

    let want;
    if (toggle !== undefined && toggle !== '') {
      toggle = String(toggle);
      if (!exists(toggle)) return { error: 'unknown', unit: toggle };
      want = new Set(mine);
      if (!want.delete(toggle)) want.add(toggle);
    } else {
      want = new Set((units ?? []).map(String));
      for (const unit of want) if (!exists(unit)) return { error: 'unknown', unit };
    }
    if (want.size > max) return { error: 'limit', max, unit: toggle };
    for (const unit of want) {
      if (!mine.has(unit) && all.has(unit)) return { error: 'taken', unit };
    }

    const before = mine.size ? store.get(N.holders, `${pool}/${holder}`) : null;
    const since = before?.since ?? at;
    let until = 0;
    if (want.size) {
      until = at + holdMs;
      if (ceilingMs) until = Math.min(until, since + ceilingMs);
    }

    const writes = [];
    for (const unit of want) writes.push(store.write(N.units, `${pool}/${unit}`, { state: 'held', by: holder, until }));
    for (const unit of mine) if (!want.has(unit)) writes.push(store.write(N.units, `${pool}/${unit}`, FREE));
    const list = [...want].sort(order);
    writes.push(store.write(N.holders, `${pool}/${holder}`, summary(list, until, want.size ? since : 0)));
    await Promise.all(writes);
    return { ok: true, units: list, until };
  }

  /** Let go of everything a holder has in a pool. */
  const release = (holder, pool) => choose(holder, pool, { units: [] });

  /** Turn a holder's live holds into taken units (paid for, checked in). They no longer expire. */
  async function confirm(holder, pool) {
    if (!holder) return { error: 'no-holder' };
    const mine = held(holder, pool).units;
    if (!mine.length) return { error: 'nothing-held' };
    const writes = mine.map((unit) => store.write(N.units, `${pool}/${unit}`, { state: N.taken, by: holder, until: 0 }));
    writes.push(store.write(N.holders, `${pool}/${holder}`, summary([], 0, 0)));
    await Promise.all(writes);
    return { ok: true, units: mine };
  }

  /** Let go of every hold whose time is up, and tell everyone. Returns how many. */
  async function sweep(at = now()) {
    const lapsed = store.under(N.units).filter((doc) => doc.state === 'held' && doc.until <= at);
    if (!lapsed.length) return 0;
    const writes = [];
    const holders = new Set();
    for (const doc of lapsed) {
      holders.add(`${poolOf(doc.key)}/${doc.by}`);
      writes.push(store.write(N.units, doc.key, FREE));
    }
    for (const key of holders) {
      // A holder may have chosen again since; only empty the summary if nothing of theirs is live.
      const pool = poolOf(key);
      const left = mineIn(taken(pool, at), key.slice(pool.length + 1));
      if (!left.length) writes.push(store.write(N.holders, key, summary([], 0, 0)));
    }
    await Promise.all(writes);
    return lapsed.length;
  }

  const timer = sweepMs ? setInterval(() => sweep().catch((error) => console.error(error)), sweepMs) : null;
  timer?.unref?.();

  return { holdMs, taken, held, choose, release, confirm, sweep, close: () => clearInterval(timer) };
}

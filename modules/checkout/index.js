// checkout: turn a cart into a paid order, all or nothing.
//
// Taken from Tailgate's `placeOrder` (src/market.js, fc0f6ae), from one listing to a whole cart.
// The steps, in the order that keeps them safe:
//
//   1. Read the cart, price it, add the fees.
//   2. Take the stock for every line and record the checkout as pending, before the first
//      `await`. A second buyer of the last one is refused here; a second press of the same
//      button finds the checkout pending.
//   3. Charge once (`pay`, keyed by the checkout).
//   4. Paid: one order per group (Tailgate: per farm, since each farm's goods are picked up on
//      their own) starts at the first step, and the bought lines leave the cart. Declined: the
//      stock goes back and the cart is untouched, so the buyer can try another card.
//
//   <collection>/<key>   { owner, state: 'pending' | 'paid' | 'failed', lines, fees, cents, orders, ref, reason, at }
//   orders: whatever `stages` keeps, started with { checkout, owner, group, lines, cents, fee, ...fields }
//
// `key` comes from the form (a hidden field made when the page was), so a resubmitted form is the
// same checkout. Without one, each call is a new checkout.
//
// Someone else having bought the last one is `not-ready`, with `lines` saying which. (`take` also
// answers `sold-out`, but nothing awaits between reading the cart and taking, so here it can't.)
//
// Answers are `{ ok: true, ... }` or `{ error: <code>, ... }`. The app chooses the words.

const LINE = ({ item, qty, name, unit, cents, total }) => ({ item, qty, name, unit, cents, total });
const newKey = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createCheckout({
  store,
  catalog,
  cart,
  pay,
  stages,
  notify = null,
  collection = 'checkouts',
  // Which order a line goes to. '' for all in one. Tailgate: the farm, from the item key.
  group = () => '',
  // [{ label, cents, group? }] for a cart: delivery, a booking fee. A fee with a group goes on
  // that group's order; one without goes on the first.
  fees = () => [],
  // The template `notify` sends once an order is paid, if the app passes a `contact`.
  template = 'placed',
  now = Date.now,
} = {}) {
  if (!store || !catalog || !cart || !pay || !stages) throw new TypeError('createCheckout needs a store, catalog, cart, pay and stages');

  const groupOf = (line) => String(group(line) ?? '');

  /**
   * What checking out would charge now, without writing anything: the cart's lines, the fees,
   * and one entry per order (`group`, `lines`, `cents`, `fee`, `total`), with the grand total.
   * `fields` are the ones `place` would put on the orders, so a fee can depend on them (pickup).
   */
  function quote(owner, { context = {}, fields = {} } = {}) {
    const view = cart.view(owner, context);
    const lines = view.lines.filter((line) => !line.gone && !line.short).map(LINE);
    const extra = fees({ lines, cents: view.cents, context, fields }) ?? [];
    for (const fee of extra) if (!Number.isInteger(fee?.cents) || fee.cents < 0) throw new TypeError('A fee is { label, cents } in whole cents');
    const groups = new Map();
    for (const line of lines) {
      if (!groups.has(groupOf(line))) groups.set(groupOf(line), []);
      groups.get(groupOf(line)).push(line);
    }
    const names = [...groups.keys()];
    const orders = names.map((name, i) => {
      const mine = groups.get(name);
      const cents = mine.reduce((sum, line) => sum + line.total, 0);
      // A fee with a group goes on that group's order; one without goes on the first.
      const fee = extra.filter((one) => (one.group === undefined ? i === 0 : String(one.group) === name)).reduce((sum, one) => sum + one.cents, 0);
      return { group: name, lines: mine, cents, fee, total: cents + fee };
    });
    return { ready: view.ready, lines: view.lines, fees: extra, orders, cents: view.cents + extra.reduce((sum, fee) => sum + fee.cents, 0) };
  }

  return {
    /** A checkout as it stands, or null. */
    get: (key) => store.get(collection, key),

    quote,

    /**
     * Check out `owner`'s cart. `method` goes to the payment provider and is never stored;
     * `fields` go on every order (an address, a pickup time); `contact` is who `notify` tells.
     */
    async place(owner, { key = newKey(), context = {}, method, fields = {}, contact = null, description = '' } = {}) {
      if (!owner) return { error: 'no-owner' };
      if (!key || typeof key !== 'string') return { error: 'no-key' };
      const before = store.get(collection, key);
      if (before) {
        if (before.owner !== owner) return { error: 'not-yours' };
        if (before.state === 'paid') return { ok: true, again: true, key, orders: before.orders, ref: before.ref };
        if (before.state === 'pending') return { error: 'in-progress' };
      }

      // 1. The cart, priced now.
      const quoted = quote(owner, { context, fields });
      if (!quoted.lines.length) return { error: 'empty' };
      if (!quoted.ready) return { error: 'not-ready', lines: quoted.lines.filter((line) => line.gone || line.short) };
      const lines = quoted.orders.flatMap((order) => order.lines);
      const extra = quoted.fees;
      const cents = quoted.cents;

      // 2. Stock and the pending checkout, both stored before the first await.
      const taken = catalog.take(lines);
      if (taken.error) return taken;
      const pending = store.write(collection, key, { owner, state: 'pending', lines, fees: extra, cents, orders: [], ref: '', reason: '', at: now() });
      await Promise.all([taken.sent, pending]);

      // 3. Charge once.
      const paid = await pay.pay({ id: `checkout/${key}`, cents, description, method });
      if (!paid.ok) {
        await catalog.restock(lines);
        await store.write(collection, key, { state: 'failed', reason: paid.error, at: now() });
        return { error: paid.error, key };
      }

      // 4. The orders, and the cart.
      const orders = quoted.orders.map((order) => (quoted.orders.length === 1 && order.group === '' ? key : `${key}/${order.group}`));
      const started = quoted.orders.map((order, i) => stages.start(orders[i], { ...fields, checkout: key, owner, group: order.group, lines: order.lines, cents: order.cents, fee: order.fee }));
      const done = store.write(collection, key, { state: 'paid', ref: paid.ref, orders, at: now() });
      await Promise.all([...started, done, cart.clear(owner, lines)]);

      let told = null;
      if (notify && contact) {
        try {
          told = await notify.notify(contact, template, { key, lines, cents, orders });
        } catch (error) {
          told = { error: 'not-sent', detail: String(error?.message ?? error) };
        }
      }
      return { ok: true, key, orders, ref: paid.ref, cents, ...(told ? { notified: Boolean(told.ok) } : {}) };
    },
  };
}

// checkout: turn a cart into a paid order, all or nothing.
//
// Taken from Tailgate's placeOrder (src/market.js, 3ec2c31), from one line to a whole cart, with
// payment added. The order of steps is the point:
//
//   1. The cart is read, and must be as it was shown (`changed` otherwise, with the lines).
//   2. Its stock is taken (`catalog.take`) and the cart emptied, before anything is awaited: a
//      second press finds an empty cart, and a second buyer finds the stock gone.
//   3. It's paid, once (`pay`), for the cart's total plus `extras` (a delivery fee).
//   4. Paid: the order starts at its first step (`stages`), one order per `group` (a farm, a
//      department), all under one payment. Not paid: the stock and the cart are put back.
//
//   orders/<id>          (or <id>-<group>) { holder, lines, cents, extras, total, payment, ...details }
//   payments/<id>        (the pay module's)
//
// Answers are `{ ok: true, id, orders }` or `{ error: <code>, ... }`: `empty`, `changed`,
// `gone`, `short`, or the payment's own reason (`declined`, `in-progress`, ...).

export function createCheckout({
  catalog,
  cart,
  pay,
  stages,
  // [{ label, cents }] added to a group's total, from its lines' view and the checkout's details.
  extras = () => [],
  // Which order a line belongs to, by item key. One order for the whole cart by default.
  group = () => '',
  id = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
} = {}) {
  if (!catalog || !cart || !pay || !stages) throw new TypeError('createCheckout needs a catalog, a cart, pay and stages');

  const groupsOf = (lines) => {
    const groups = new Map();
    for (const line of lines) {
      const name = group(line.item);
      groups.set(name, [...(groups.get(name) ?? []), line]);
    }
    return groups;
  };
  const sum = (list) => list.reduce((total, entry) => total + entry.cents, 0);

  /**
   * What `checkout(holder, details)` would charge, by order: the lines, the extras and the
   * totals, and the grand total. Nothing is written.
   */
  function quote(holder, details = {}, context = {}) {
    const view = cart.view(holder, context);
    const orders = [...groupsOf(view.lines)].map(([name, lines]) => {
      const added = extras({ group: name, lines, cents: sum(lines) }, details);
      return { group: name, lines, cents: sum(lines), extras: added, total: sum(lines) + sum(added) };
    });
    return { ok: view.ok, lines: view.lines, orders, total: sum(orders.map((order) => ({ cents: order.total }))) };
  }

  return {
    quote,

    /**
     * Check out `holder`'s cart. `details` are kept on each order (an address, a pickup time);
     * `method` goes to the payment provider and is never stored.
     */
    async checkout(holder, { details = {}, method, context = {}, description = '' } = {}) {
      if (!holder) return { error: 'no-holder' };
      const quoted = quote(holder, details, context);
      if (!quoted.lines.length) return { error: 'empty' };
      if (!quoted.ok) return { error: 'changed', lines: quoted.lines };
      const taking = quoted.lines.map(({ item, qty }) => ({ item, qty }));

      // Step 2, with no await from reading the cart to emptying it: the view just said every line
      // can be had, from the same state `take` reads, so it can't be refused here.
      const taken = catalog.take(taking);
      const emptied = cart.clear(holder);
      const [took] = await Promise.all([taken, emptied]);
      if (took.error) throw new Error(`checkout: the stock changed between the cart's view and take (${took.error})`);

      const checkoutId = id();
      const paid = await pay.pay({ id: checkoutId, cents: quoted.total, method, description });
      if (paid.error) {
        // Not paid: the stock goes back, and so do the lines (beside anything added meanwhile).
        await catalog.give(taking);
        for (const { item, qty } of taking) {
          const had = cart.lines(holder).find((line) => line.item === item)?.qty ?? 0;
          await cart.set(holder, item, had + qty).then((result) => (result.ok ? result : cart.set(holder, item, had)));
        }
        return { error: paid.error };
      }

      const orders = [];
      const many = quoted.orders.length > 1;
      for (const order of quoted.orders) {
        const key = many ? `${checkoutId}-${order.group}` : checkoutId;
        await stages.start(key, {
          ...details,
          holder,
          group: order.group,
          lines: order.lines.map(({ item, qty, name, unit, each, cents }) => ({ item, qty, name, unit, each, cents })),
          cents: order.cents,
          extras: order.extras,
          total: order.total,
          payment: checkoutId,
        });
        orders.push(key);
      }
      return { ok: true, id: checkoutId, orders, total: quoted.total };
    },
  };
}

// pay: collect money for an order.
//
// The kit does not move money. A provider does, behind one function:
//
//   charge({ id, cents, currency, description, method })  →  { ok: true, ref } | { error: <reason> }
//
// What the kit owns is the part every provider needs around it: an order is charged at most once,
// however many times the button is pressed or the request is retried.
//
//   <collection>/<order id>   { state: 'pending' | 'paid' | 'failed', cents, currency, ref, reason, at }
//
// `method` (a card, a wallet token) goes to the provider and is never stored.
//
// Ids are one namespace for everything that pays through this store, so each payer prefixes its
// own (`checkout/<key>`, `booking/<key>`): a booking's payment must never count for a checkout
// that happens to share its key. A paid id asked for again with a different amount is refused.

export function createPay({ provider, store, collection = 'payments', now = Date.now } = {}) {
  if (typeof provider?.charge !== 'function') throw new TypeError('createPay needs a provider with charge()');
  if (!store) throw new TypeError('createPay needs a store');

  return {
    /** The payment for an order as it stands, or null. */
    paid: (orderId) => store.get(collection, orderId),

    /**
     * Charge an order. Asking again for a paid order, for the same amount, returns the first
     * payment; it is not charged twice. A different amount is `paid-other-amount`, never ok.
     */
    async pay({ id, cents, currency = 'usd', description = '', method } = {}) {
      if (!id) return { error: 'no-order' };
      if (!Number.isInteger(cents) || cents <= 0) return { error: 'bad-amount' };
      const before = store.get(collection, id);
      if (before?.state === 'paid') {
        if (before.cents !== cents || (before.currency ?? 'usd') !== currency) return { error: 'paid-other-amount' };
        return { ok: true, ref: before.ref, again: true };
      }
      if (before?.state === 'pending') return { error: 'in-progress' };

      // Stored before the first await: a second request for this order sees 'pending'.
      const claim = store.write(collection, id, { state: 'pending', cents, currency, ref: '', reason: '', at: now() });
      let result;
      try {
        await claim;
        result = await provider.charge({ id, cents, currency, description, method });
      } catch (error) {
        result = { error: 'provider-failed', detail: String(error?.message ?? error) };
      }
      if (result?.ok) {
        await store.write(collection, id, { state: 'paid', ref: String(result.ref ?? ''), at: now() });
        return { ok: true, ref: String(result.ref ?? '') };
      }
      const reason = String(result?.error ?? 'declined');
      await store.write(collection, id, { state: 'failed', reason, at: now() });
      return { error: reason };
    },
  };
}

/** The card number the test provider declines. Anything else succeeds. */
export const FAILING_CARD = '4000000000000002';

/** A provider that takes no money. For prototypes and tests; label the checkout "Test mode". */
export function testProvider() {
  let count = 0;
  return {
    name: 'test',
    async charge({ method } = {}) {
      if (String(method?.card ?? '').replace(/\D/g, '') === FAILING_CARD) return { error: 'declined' };
      return { ok: true, ref: `test_${++count}` };
    },
  };
}

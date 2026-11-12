# Kit

Shared server modules for Potomac Solutions' platforms (Tailgate, CineStack, Outfitter and the rest). Built to sit on [Zubra](https://github.com/journey-to-code-org/zubra): `@zubra/server`, `@zubra/actions`, `@zubra/sync` and Zubra UI.

Private. The name is a placeholder. Version 0.2.0: no dependencies, Node 22.13 or later.

## What belongs here

Code that knows what a business is: a tenant, a hold, an order moving through stages, a price rule. None of that belongs in Zubra, which compiles components and knows nothing about bookings.

```
Platforms   apps: pages, components, seed data, one business's rules
Kit         this repository
Zubra UI    components any app would want unchanged
Siblings    @zubra/server · @zubra/actions · @zubra/sync
Core        compiler · runtime
```

Each layer imports only from the layers below it.

## Rules

1. **One job.** A module's job fits in one sentence with no "and". If it needs an "and", it is two modules.
2. **Taken from working code, and proved against it.** A module starts from code an app already runs, with that app's nouns removed (no "seat", "film" or "farm"). It is in when that app's own tests pass with the app importing the module. A module nothing has run yet is marked as such below.
3. **Borrow the hard part.** Payments, login, text messages and file storage sit behind a small interface with one reference implementation. The kit does not own the engine.
4. **Nothing leaks downward.** If a module needs Zubra to change, the change must make sense to someone who has never heard of this repository.
5. **Answers are codes, not sentences.** A module returns `{ ok: true, ... }` or `{ error: 'taken', unit }`. The app chooses the words.

## Modules

| Import | Its one job | From | Proved by |
| --- | --- | --- | --- |
| `kit/hold` | Reserve one contested thing for a window of time | CineStack `src/box-office.js` | CineStack's 5 browser tests, unchanged |
| `kit/stages` | Move a record through named steps | Tailgate `src/market.js` | Tailgate's 9 browser tests |
| `kit/tenant` | Say which business a request is for | New | Its own tests only |
| `kit/price` | Turn an item and a context into a price | New | Its own tests only |
| `kit/pay` | Collect money for an order | New (`pay(order)` from the CineStack plan) | Its own tests only |
| `kit/auth` | Say who is asking | Both apps' `src/session.js` | Its own tests only |
| `kit/notify` | Tell a person something | New, interface and an outbox | Its own tests only |
| `kit/files` | Keep a file and return its address | New, interface, memory and disk | Its own tests only |
| `kit/store` | The seam to where documents live (below) | Both apps | Both apps' tests; `syncStore` on `@zubra/sync` 5.8 |

Features, built from the rules:

| Import | Its one job | Built from | From | Proved by |
| --- | --- | --- | --- | --- |
| `kit/catalog` | Say what's for sale and how many are left | `store`, `price` | Tailgate's `catalog()` and stock check | Its own tests, and Tailgate's listing shape through `read`/`left`/`listed` |
| `kit/cart` | Keep what someone means to buy | `store`, `catalog` | New | Its own tests only |
| `kit/checkout` | Turn a cart into a paid order, all or nothing | `catalog`, `cart`, `pay`, `stages`, `notify` | Tailgate's `placeOrder`, from one line to many | Its own tests, twelve buyers at once, and over a real Sync server |

Not here yet: `reserve` (next), `forms`.

Each module's `index.js` opens with what it does, the documents it writes and the interface it borrows. That comment is the module's documentation.

## The store

The kit owns no storage. Every module that keeps anything is handed a store:

```js
get(collection, key)             // one document's fields, or null            (synchronous)
under(collection, prefix = '')   // [{ key, ...fields }] whose key starts so  (synchronous)
write(collection, key, fields)   // merge fields; stored before it returns; the promise is the broadcast
```

Because reads are synchronous and a write is stored before it returns, a module can check and then write with nothing in between. Every "exactly one wins" in the kit rests on that, so a store that awaits before storing breaks the kit. `checkStore(store, assert)` tests a store against the contract.

In a Zubra app the store is the Sync log read on the server, so what a module writes reaches every open page:

```js
import { createHolds } from '@potomac-solutions/kit/hold';

const holds = createHolds({
  store: { get: log.get, under: log.under, write },   // CineStack's fieldLog and server write
  holdMs: 5 * 60_000,
  sweepMs: 1000,
  max: 8,
  names: { units: 'seats', holders: 'holds', list: 'seats', taken: 'sold' },
});

const answer = await holds.choose(guest.pub, showing.id, { toggle: 'C8' }, { valid: seatIds });
// { ok: true, units: ['C8'], until } or { error: 'taken', unit: 'C8' }
```

`memoryStore()` is for tests and for apps with nothing to sync. `await syncStore(sync)` is the store over a Zubra Sync server (`createSyncServer`, or a `ZubraSync` Durable Object from inside it), `@zubra/sync` 5.8 or later; the kit is handed the server and imports nothing from Zubra.

## A checkout

```js
import { syncStore } from '@potomac-solutions/kit/store';
import { createCatalog } from '@potomac-solutions/kit/catalog';
import { createCart } from '@potomac-solutions/kit/cart';
import { createCheckout } from '@potomac-solutions/kit/checkout';

const store = await syncStore(sync);
const catalog = createCatalog({ store });                 // items/<seller>/<item> { name, unit, cents, left }
const cart = createCart({ store, catalog });              // carts/<owner> { <item>: qty }
const checkout = createCheckout({
  store, catalog, cart, pay, stages,
  group: (line) => line.item.split('/')[0],               // one order per seller
  fees: ({ lines }) => [{ label: 'Delivery', cents: 400 }],
});

await cart.add(guest.pub, 'hillside/eggs', 2);
const done = await checkout.place(guest.pub, { key: form.get('checkout'), method, fields: { address } });
// { ok: true, key, orders: ['c…/hillside'], ref, cents } or { error: 'not-ready', lines } / 'declined' / 'in-progress'
```

The order of things inside `place` is what makes it safe: stock is taken and the checkout recorded as pending before the first `await`, then the card is charged once (keyed by the checkout), then the orders start. A declined card puts the stock back and leaves the cart alone.

## Checking it

```sh
npm test          # 70 tests, Node's own runner
npm run mutate    # breaks 35 behaviours one at a time; each must fail a test
```

`proof/` holds the two patches that move CineStack (at 1c17019) and Tailgate (at fc0f6ae) onto the kit. They are the record of what "proved by" means above, and the starting point when those apps resume.

## Known limits

- **A hold is inside one pool.** Reserving a kayak for Friday to Sunday is three pools, and `choose` is all-or-nothing in one pool only. Outfitter will need a choice across pools.
- **The sweep reads every unit document.** Fine for one theatre's evening; needs an index on `until` beyond that.
- **Tenancy is a lookup, not isolation.** `tenant` says which business a request is for. Keeping one business's documents away from another's is the store's job, and waits on a decision (one Sync log per business).
- **`auth` uses `node:crypto`,** so it does not run on Workers yet.
- **A checkout left pending stays pending.** If the server stops between taking stock and hearing from the provider, the stock stays taken and the checkout says `pending`. Nothing sweeps it yet; the provider's own record (keyed by the checkout) says whether money moved.
- **Cart and checkout have one app behind them.** Their options are few on purpose until CineStack and a third app use them.

## Plan

`plan/roadmap-ecosystem.md` and `plan/roadmap-verticals.md` in the Zubra planning project.

# Kit

Shared server modules for Potomac Solutions' platforms (Tailgate, CineStack, Outfitter and the rest). Built to sit on [Zubra](https://github.com/journey-to-code-org/zubra): `@zubra/server`, `@zubra/actions`, `@zubra/sync` and Zubra UI.

Private. The name is a placeholder. Version 0.4.0: no dependencies, Node 22.13 or later.

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
| `kit/hold` | Reserve one contested thing for a window of time; `chooseAcross` for several pools at once, all or nothing | CineStack `src/box-office.js` | CineStack's 5 browser tests, unchanged |
| `kit/stages` | Move a record through named steps | Tailgate `src/market.js` | Tailgate's 9 browser tests |
| `kit/tenant` | Say which business a request is for | New | Its own tests only |
| `kit/tenancy` | Keep each business's documents apart: one Sync log each, its sync traffic routed by host | New | Two businesses on one HTTP server, a SQLite file each: pull, push and the live stream |
| `kit/price` | Turn an item and a context into a price | New | Its own tests only |
| `kit/pay` | Collect money for an order | New (`pay(order)` from the CineStack plan) | Its own tests only |
| `kit/auth` | Say who is asking | Both apps' `src/session.js` | Its own tests only |
| `kit/notify` | Tell a person something | New, interface and an outbox | Its own tests only |
| `kit/files` | Keep a file and return its address | New, interface, memory and disk | Its own tests only |
| `kit/store` | The seam to where documents live (below) | Both apps | Both apps' tests; `syncStore` on `@zubra/sync` 5.8 |

Features, built from the rules:

| Import | Its one job | Built from | From | Proved by |
| --- | --- | --- | --- | --- |
| `kit/catalog` | Say what's for sale and how many are left | `store`, `price` | Tailgate's `catalog()` and stock check; `put`, no-limit stock and `active` from the first C1 (#1) | Its own tests, and Tailgate's listing shape through `read`/`left`/`listed` |
| `kit/cart` | Keep what someone means to buy | `store`, `catalog` | New | Its own tests only |
| `kit/checkout` | Turn a cart into a paid order, all or nothing | `catalog`, `cart`, `pay`, `stages`, `notify` | Tailgate's `placeOrder`, from one line to many; `quote` from the first C1 (#1) | Its own tests, twelve buyers at once, and over a real Sync server |
| `kit/reserve` | Book a unit, or several, for a stretch of pools (days, a showing), all or nothing; `states` and `days` for the components | `hold`, `price`, `pay`, `stages` | CineStack's box office; the multi-pool hold | Its own tests: a kayak Friday to Sunday, the same free kayak every day, a payment that outlasts the hold, and CineStack's seats in its own collections |

Not here yet: `forms`.

## Components

`.zb` components in `components/`, on Zubra UI's parts. Each takes plain data as props and posts plain forms to the app's own routes, so it works before and without JavaScript; none reads the store. Themed by Zubra UI's CSS variables, so each business's colours apply.

| Component | Shows | Props | Posts |
| --- | --- | --- | --- |
| `catalog-grid` | Items, price (and the price before a rule), what's left, sold out | `items` (`catalog.items()`, plus a `seller` name if you like), `add` | `add`: `item`, `qty=1` |
| `cart-panel` | Lines, − and +, remove, fees, total; a line that sold out | `cart` (`cart.view()`), `fees`, `change`, `checkout` (a link, off while the cart can't be bought) | `change`: `item`, `qty` (0 removes) |
| `checkout-form` | The order and total again, who and where, the card | `cart`, `fees`, `place`, `checkout` (the key), `delivery`, `problem`, `test-mode` | `place`: `checkout`, `name`, `email`, `phone`, `address`, `card` |
| `order-status` | An order's steps, or a side step (cancelled) as a badge; what's in it | `order` (the document `stages` keeps), `steps`, `labels` | nothing |
| `slot-picker` | Days (or any pools) with how many are free, and how many to hold; a full day can't be picked | `days` (`reserve.days()`, plus a `label`), `hold`, `key`, `count`, `max`, `unit` | `hold`: `key`, each `pool`, `count` |
| `seat-map` | Seats in rows, with aisles: free, yours, being held, taken | `rows` (lists of `reserve.states()` entries, `null` for an aisle), `toggle`, `key` | `toggle`: `key`, `toggle` (the seat) |
| `booking-summary` | A held booking: each unit and day priced, the total, how long it's held; Book and Let go. Nothing once it isn't held | `booking` (`reserve.get()`), `labels`, `held-until`, `book`, `release`, `key`, `unit` | `release`: `key` |

A booking is paid with `checkout-form`, its lines given as a cart's (one per unit and day).

They carry the six Zubra UI parts they use (`action-button`, `alert-banner`, `empty-state`, `status-badge`, `step-indicator`, `text-field`, from zubra-ui 0d2fdd0, unchanged), so the package works on its own.

### Using them (Zubra 5.9 or later)

The app's server reads them from `node_modules`:

```js
createZubra({ components, packages: ['@potomac-solutions/kit/components'] });
```

and a page or component imports them by name:

```html
<script>import '@potomac-solutions/kit/components/cart-panel.zb'</script>
```

`@zubra/server` 5.9 is an optional peer dependency: an app using only the functions doesn't need it.

## A booking

```js
const reserve = createReserve({
  store, holds, pay, stages,                       // stages: e.g. ['booked', 'out', 'returned']
  base: 4000,                                      // or (unit, pool) => cents
  rules: [{ label: 'Weekend', when: { day: [0, 6] }, set: 5000 }],
  context: (pool) => moment(dayOf(pool), 'America/New_York'),
});

const days = ['kayaks/2026-11-20', 'kayaks/2026-11-21', 'kayaks/2026-11-22'];
await reserve.hold(guest.pub, { key, pools: days, count: 1, from: fleet });   // the same kayak all three days, or nothing
await reserve.book(guest.pub, key, { method, fields: { phone } });           // charged once; confirmed every day
```

`book` checks every hold is still live, keeps them through the payment (`payMs`), charges the price shown when they were held, then confirms the units in every pool and starts the booking. A declined card confirms nothing; the holds run out on their own and it can be tried again while they last. CineStack's seats are one pool and a list of seats.

## Many businesses on one deployment

Each business gets its own Sync log (a SQLite file here, a Durable Object on Cloudflare), so nothing has to be filtered out of a shared one:

```js
import { createTenants } from '@potomac-solutions/kit/tenant';
import { createTenancy } from '@potomac-solutions/kit/tenancy';

const tenancy = createTenancy({
  tenants: createTenants({ tenants }),                      // { id, hosts, theme, modules }
  open: async (tenant) => createSyncServer({ log: await sqliteLog(`data/${tenant.id}.db`) }),
  setup: ({ store }) => ({ catalog: createCatalog({ store }), holds: createHolds({ store }) }),
});

if (await tenancy.handle(req, res)) return;              // the page's sync requests, to its business's log
const space = await tenancy.space(req);                  // { tenant, sync, store, catalog, holds }
if (!space) return notFound(res);                        // a host nobody answers to
```

The business comes from the host name only. A business's log is opened the first time it's asked for, once, and its features are built on its own store. On Durable Objects the object is the log: send each business to its own (`idFromName(tenant.id)`) and run the kit inside it.

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

`catalog.put(key, fields)` adds or changes an item, checked (a new one needs a name and a price). A count of `null` is no limit (a service, a download); `active: false` takes an item off sale without losing it. `checkout.quote(owner, { fields })` says what `place` would charge, order by order, without writing anything; fees see the fields, so a pickup can drop delivery.

The order of things inside `place` is what makes it safe: stock is taken and the checkout recorded as pending before the first `await`, then the card is charged once (keyed by the checkout), then the orders start. A declined card puts the stock back and leaves the cart alone.

## Checking it

```sh
npm test                          # 105 tests, Node's own runner
npm run mutate                    # breaks 67 behaviours one at a time; each must fail a test
npm run test:browser              # the components from the package in Chrome, with and without JavaScript (playwright)
npm run mutate -- --components    # breaks 14 component behaviours; each must fail a browser test
```

`components/test/shop.js` is the smallest shop the components make (`node components/test/shop.js`, then http://localhost:8040); `components/test/rentals.js` the smallest outfitter and cinema (http://localhost:8041).

`proof/` holds the two patches that move CineStack (at 1c17019) and Tailgate (at fc0f6ae) onto the kit. They are the record of what "proved by" means above, and the starting point when those apps resume.

## Known limits

- **`tenancy` holds each business's log in one process.** Several processes serving one business need a shared log and pub/sub between them (Zubra Sync's own note); on Cloudflare, one Durable Object per business does that.

- **A holder holds one list per pool.** Two drafts of `reserve` by the same person in the same pool share it, so the second replaces the first there.
- **A payment that outlives `payMs` (2 minutes by default) is paid but not booked.** `book` answers `lapsed-after-payment` with the provider's `ref`, so the app can refund; the kit doesn't refund.
- **The sweep reads every unit document.** Fine for one theatre's evening; needs an index on `until` beyond that.
- **Tenancy is a lookup, not isolation.** `tenant` says which business a request is for. Keeping one business's documents away from another's is the store's job, and waits on a decision (one Sync log per business).
- **`auth` uses `node:crypto`,** so it does not run on Workers yet.
- **A checkout left pending stays pending.** If the server stops between taking stock and hearing from the provider, the stock stays taken and the checkout says `pending`. Nothing sweeps it yet; the provider's own record (keyed by the checkout) says whether money moved.
- **An app with its own copy of a Zubra UI part, using the kit as a package, ships both.** The first to load defines the tag. Harmless while they match; Zubra has no rule yet for an app tag and a package tag that differ.
- **Cart and checkout have one app behind them.** Their options are few on purpose until CineStack and a third app use them.

## Plan

`plan/roadmap-ecosystem.md` and `plan/roadmap-verticals.md` in the Zubra planning project.

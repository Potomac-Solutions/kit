// The smallest outfitter and cinema the kit's booking components make: pick days and how many
// kayaks, or seats at a showing; see what's held; book it with checkout-form; see the booking.
// Plain routes and form posts, as an app on the kit would have them. Used by the browser tests;
// `node components/test/rentals.js` serves it on :8041.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createZubra } from '@zubra/server';
import { memoryStore } from '../../modules/store/index.js';
import { createHolds } from '../../modules/hold/index.js';
import { createPay, testProvider } from '../../modules/pay/index.js';
import { createStages } from '../../modules/stages/index.js';
import { createReserve } from '../../modules/reserve/index.js';
import { moment } from '../../modules/price/index.js';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FLEET = ['k1', 'k2', 'k3'];
const DAYS = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'].map((date) => `kayaks/${date}`);
const SHOW = 'show-1930';
const SEATS = [['A1', 'A2', null, 'A3', 'A4'], ['B1', 'B2', null, 'B3', 'B4']];
const STEPS = ['booked', 'out', 'returned'];
const PROBLEMS = {
  taken: 'Someone just took one of those. Pick again.',
  'none-free': 'Not that many free on every one of those days.',
  'no-pools': 'Pick at least one day.',
  lapsed: 'Your hold ran out. Pick again.',
  declined: 'That card was declined. Try another.',
  limit: 'That’s as many as you can hold at once.',
};
const dateOf = (pool) => new Date(`${pool.split('/')[1]}T16:00:00Z`);
const labelOf = (pool) => (pool === SHOW ? '7:30 pm' : new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/New_York' }).format(dateOf(pool)));

export async function createRentals({ now = Date.now, holdMs = 5 * 60_000 } = {}) {
  const app = mkdtempSync(join(tmpdir(), 'kit-rentals-'));
  const components = join(app, 'components');
  mkdirSync(components);
  mkdirSync(join(app, 'node_modules', '@potomac-solutions'), { recursive: true });
  symlinkSync(kitRoot, join(app, 'node_modules', '@potomac-solutions', 'kit'), 'dir');
  const zubra = createZubra({ components, root: app, packages: ['@potomac-solutions/kit/components'], cache: false });

  const store = memoryStore();
  const holds = createHolds({ store, holdMs, max: 4, now });
  const stages = createStages({ store, collection: 'rentals', steps: STEPS, stamp: false });
  const reserve = createReserve({
    store,
    holds,
    pay: createPay({ provider: testProvider(), store }),
    stages,
    base: (unit, pool) => (pool === SHOW ? 1100 : 4000),
    rules: [{ label: 'Weekend', when: { day: [0, 6], kind: 'kayak' }, set: 5000 }],
    context: (pool) => (pool === SHOW ? { kind: 'seat' } : { ...moment(dateOf(pool), 'America/New_York'), kind: 'kayak' }),
    now,
  });

  const page = (title, body) => {
    const p = zubra.page();
    const html = body(p);
    return p.finish(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem;display:grid;gap:1.5rem}</style></head><body><h1>${title}</h1><nav><a href="/rent">Kayaks</a> · <a href="/cinema">Cinema</a></nav>${html}</body></html>`);
  };
  const form = async (req) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    return new URLSearchParams(body);
  };
  const who = (req, res) => {
    const found = /(?:^|; )who=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (found) return found;
    const made = randomUUID();
    res.setHeader('set-cookie', `who=${made}; Path=/; HttpOnly; SameSite=Lax`);
    return made;
  };
  const back = (res, to) => (res.writeHead(303, { location: to }), res.end());
  const send = (res, html) => (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }), res.end(html));
  const problem = (url) => (PROBLEMS[url.searchParams.get('problem')] ? `<p role="alert">${PROBLEMS[url.searchParams.get('problem')]}</p>` : '');
  // The holder's current draft for a page: a cookie per page keeps its key.
  const draftKey = (req, res, name) => {
    const found = new RegExp(`(?:^|; )${name}=([\\w-]+)`).exec(req.headers.cookie ?? '')?.[1];
    if (found) return found;
    const made = `${name}-${randomUUID()}`;
    res.appendHeader('set-cookie', `${name}=${made}; Path=/; HttpOnly; SameSite=Lax`);
    return made;
  };
  const live = (key) => ['held', 'failed'].includes(reserve.get(key)?.state);
  const summary = (p, key, unit) => {
    const booking = reserve.get(key);
    if (!booking) return ''; // booking-summary itself shows nothing unless it's held
    const until = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(new Date(booking.until));
    const labels = Object.fromEntries(booking.pools.map((pool) => [pool, labelOf(pool)]));
    return p.render('booking-summary', { booking, labels, key, book: `/book/${key}`, release: '/release', heldUntil: until, unit });
  };

  const server = createServer(async (req, res) => {
    try {
      if (zubra.handle(req, res)) return;
      const url = new URL(req.url, 'http://rentals');
      const holder = who(req, res);

      if (req.method === 'POST' && url.pathname === '/rent/hold') {
        const data = await form(req);
        const done = await reserve.hold(holder, { key: data.get('key'), pools: data.getAll('pool'), count: Number(data.get('count')), from: FLEET });
        return back(res, done.ok ? '/rent' : `/rent?problem=${done.error}`);
      }
      if (req.method === 'POST' && url.pathname === '/cinema/toggle') {
        const data = await form(req);
        const key = data.get('key');
        const had = live(key) ? reserve.get(key).units : [];
        const seat = data.get('toggle');
        const units = had.includes(seat) ? had.filter((one) => one !== seat) : [...had, seat];
        const done = units.length ? await reserve.hold(holder, { key, pools: [SHOW], units, valid: new Set(SEATS.flat().filter(Boolean)) }) : await reserve.release(holder, key);
        return back(res, done.ok ? '/cinema' : `/cinema?problem=${done.error}`);
      }
      if (req.method === 'POST' && url.pathname === '/release') {
        const data = await form(req);
        const key = data.get('key');
        const pools = reserve.get(key)?.pools ?? [];
        await reserve.release(holder, key);
        return back(res, pools.includes(SHOW) ? '/cinema' : '/rent');
      }
      if (req.method === 'POST' && url.pathname === '/book') {
        const data = await form(req);
        const key = data.get('checkout');
        const done = await reserve.book(holder, key, { method: { card: data.get('card') }, fields: { name: data.get('name'), phone: data.get('phone') } });
        return back(res, done.ok ? `/bookings/${key}` : `/book/${key}?problem=${done.error}`);
      }

      if (url.pathname === '/rent') {
        const key = draftKey(req, res, 'rent');
        return send(res, page('Kayaks', (p) => {
          const days = reserve.days(DAYS, FLEET, holder).map((day) => ({ ...day, label: labelOf(day.pool) }));
          const count = live(key) ? reserve.get(key).units.length : 1;
          return `${problem(url)}${p.render('slot-picker', { days, hold: '/rent/hold', key, count, max: FLEET.length, unit: 'kayak' })}${summary(p, key, 'Kayak')}`;
        }));
      }
      if (url.pathname === '/cinema') {
        const key = draftKey(req, res, 'seats');
        return send(res, page('Cinema', (p) => {
          const rows = SEATS.map((row) => row.map((seat) => (seat ? reserve.states(SHOW, [seat], holder)[0] : null)));
          return `${problem(url)}${p.render('seat-map', { rows, toggle: '/cinema/toggle', key })}${summary(p, key, 'Seat')}`;
        }));
      }
      if (url.pathname.startsWith('/book/')) {
        const key = url.pathname.slice('/book/'.length);
        const booking = reserve.get(key);
        if (!booking || booking.holder !== holder) return back(res, '/rent');
        // checkout-form shows lines as a cart does: one line per unit and day.
        const cart = { lines: booking.lines.map((line) => ({ item: `${line.pool}/${line.unit}`, qty: 1, name: `${labelOf(line.pool)} · ${line.unit}`, total: line.cents })), cents: booking.cents, ready: live(key) };
        return send(res, page('Book', (p) => p.render('checkout-form', { cart, place: '/book', checkout: key, problem: PROBLEMS[url.searchParams.get('problem')] ?? '', testMode: true })));
      }
      if (url.pathname.startsWith('/bookings/')) {
        const key = url.pathname.slice('/bookings/'.length);
        const record = store.get('rentals', key);
        if (!record || record.holder !== holder) return back(res, '/rent');
        const order = { ...record, lines: record.units.flatMap((unit) => record.pools.map((pool) => ({ item: `${pool}/${unit}`, qty: 1, unit: 'each', name: `${unit}, ${labelOf(pool)}` }))), fee: 0 };
        return send(res, page('Booked', (p) => p.render('order-status', { order, steps: STEPS, labels: { booked: 'Booked', out: 'Out', returned: 'Returned' }, heading: 'Your booking' })));
      }
      res.writeHead(404).end('Not found');
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end(String(error?.stack ?? error));
    }
  });
  return { server, store, holds, reserve, DAYS, SHOW };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { server } = await createRentals();
  server.listen(8041, () => console.log('http://localhost:8041'));
}

// The smallest shop the kit's components make: a shelf, a cart, a checkout, the orders. Plain
// routes and form posts on node:http, as an app built on the kit would have them. Used by the
// browser tests; `node components/test/shop.js` serves it on :8040 to look at.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createZubra } from '@zubra/server';
import { createSyncServer, memoryLog } from '@zubra/sync/server';
import { syncStore } from '../../modules/store/index.js';
import { createCatalog } from '../../modules/catalog/index.js';
import { createCart } from '../../modules/cart/index.js';
import { createCheckout } from '../../modules/checkout/index.js';
import { createPay, testProvider } from '../../modules/pay/index.js';
import { createStages } from '../../modules/stages/index.js';
import { add } from '../../bin/kit-components.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEPS = ['placed', 'claimed', 'picked', 'delivered'];
const LABELS = { placed: 'Placed', claimed: 'Driver assigned', picked: 'On the way', delivered: 'Delivered' };
const PROBLEMS = { declined: 'That card was declined. Try another.', 'not-ready': 'Something in your cart sold out. Check it and try again.', 'in-progress': 'That order is already going through.' };
const SELLERS = { hill: 'Hillside Farm', vale: 'Vale Beef' };
const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Whether the installed Zubra imports components from packages (after 5.8.0: #197). */
export const packagesWork = typeof (await import('@zubra/compiler')).packageFile === 'function';

/** Whether the installed Zubra renders `id()` on the server (after 5.8.0: #188), which ties a text-field's label to its input before JavaScript. */
export const idsWork = (() => {
  const zubra = createZubra({ components: kitRoot + '/components', cache: false });
  return /<label for="/.test(zubra.page().render('text-field', { label: 'x', name: 'x' }));
})();

/**
 * `mode: 'copy'` puts the kit's components in the app's folder, as `kit-components add` does.
 * `mode: 'package'` leaves them in the kit and has the server read them from node_modules, as an
 * app will once a Zubra release imports components from packages.
 */
export async function createShop({ stock = { eggs: 5, beef: 20, honey: 2 }, mode = 'copy' } = {}) {
  const app = mkdtempSync(join(tmpdir(), 'kit-shop-'));
  const components = join(app, 'components');
  mkdirSync(components);
  let zubraOptions = { components, cache: false };
  if (mode === 'copy') add([], components);
  else {
    mkdirSync(join(app, 'node_modules', '@potomac-solutions'), { recursive: true });
    symlinkSync(kitRoot, join(app, 'node_modules', '@potomac-solutions', 'kit'), 'dir');
    zubraOptions = { ...zubraOptions, root: app, packages: ['@potomac-solutions/kit/components'] };
  }

  const sync = createSyncServer({ log: memoryLog() });
  const store = await syncStore(sync);
  await store.write('items', 'hill/eggs', { name: 'Eggs', unit: 'dozen', cents: 600, left: stock.eggs });
  await store.write('items', 'hill/honey', { name: 'Honey', unit: 'jar', cents: 1200, left: stock.honey });
  await store.write('items', 'vale/beef', { name: 'Ground beef', unit: 'lb', cents: 899, left: stock.beef });

  const catalog = createCatalog({ store });
  const cart = createCart({ store, catalog });
  const stages = createStages({ store, collection: 'orders', steps: STEPS, owner: 'driver' });
  const seller = (line) => line.item.split('/')[0];
  const fees = ({ lines }) => [...new Set(lines.map(seller))].map((farm) => ({ label: `Delivery from ${SELLERS[farm]}`, cents: 400, group: farm }));
  const checkout = createCheckout({ store, catalog, cart, stages, pay: createPay({ provider: testProvider(), store }), group: seller, fees });
  const zubra = createZubra(zubraOptions);

  const page = (title, body) => {
    const p = zubra.page();
    const html = body(p);
    return p.finish(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem;display:grid;gap:1.5rem}</style></head><body><h1>${title}</h1><nav><a href="/">Shop</a> · <a href="/checkout">Checkout</a> · <a href="/orders">Orders</a></nav>${html}</body></html>`);
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
  const send = (res, html, status = 200) => (res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }), res.end(html));

  const server = createServer(async (req, res) => {
    try {
      if (zubra.handle(req, res)) return;
      const url = new URL(req.url, 'http://shop');
      const owner = who(req, res);
      if (req.method === 'POST' && (url.pathname === '/cart/add' || url.pathname === '/cart/change')) {
        const data = await form(req);
        const qty = Number(data.get('qty'));
        const done = url.pathname === '/cart/add' ? await cart.add(owner, data.get('item'), qty) : await cart.set(owner, data.get('item'), qty);
        return back(res, done.ok ? '/' : `/?problem=${done.error}`);
      }
      if (req.method === 'POST' && url.pathname === '/checkout') {
        const data = await form(req);
        const done = await checkout.place(owner, {
          key: data.get('checkout'),
          method: { card: data.get('card') },
          fields: { name: data.get('name'), address: data.get('address') },
          description: 'Kit test shop',
        });
        return back(res, done.ok ? `/orders/${done.key}` : `/checkout?problem=${done.error}`);
      }
      if (url.pathname === '/') {
        return send(res, page('Shop', (p) => {
          const items = catalog.items('', {}, { all: true }).map((item) => ({ ...item, seller: SELLERS[item.key.split('/')[0]] }));
          const problem = url.searchParams.get('problem');
          return `${problem ? `<p role="alert">${escape(problem)}</p>` : ''}${p.render('catalog-grid', { items, add: '/cart/add' })}${p.render('cart-panel', { cart: cart.view(owner), fees: fees({ lines: cart.view(owner).lines }), change: '/cart/change', checkout: '/checkout' })}`;
        }));
      }
      if (url.pathname === '/checkout') {
        const view = cart.view(owner);
        const problem = PROBLEMS[url.searchParams.get('problem')] ?? '';
        return send(res, page('Checkout', (p) => p.render('checkout-form', { cart: view, fees: fees({ lines: view.lines }), place: '/checkout', checkout: `c-${randomUUID()}`, delivery: true, problem, testMode: true })));
      }
      if (url.pathname.startsWith('/orders')) {
        const key = decodeURIComponent(url.pathname.slice('/orders/'.length));
        const mine = store.under('orders').filter((order) => order.owner === owner && (!key || order.checkout === key));
        return send(res, page('Orders', (p) => mine.map((order) => p.render('order-status', { order, steps: STEPS, labels: LABELS, heading: `From ${SELLERS[order.group]}` })).join('') || '<p>No orders yet.</p>'));
      }
      send(res, 'Not found', 404);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, String(error?.stack ?? error), 500);
    }
  });
  return { server, store, stages, catalog };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { server } = await createShop();
  server.listen(8040, () => console.log('http://localhost:8040'));
}

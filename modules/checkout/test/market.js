// The test market both checkout tests and the Sync test use.
import { memoryStore } from '../../store/index.js';
import { createCatalog } from '../../catalog/index.js';
import { createCart } from '../../cart/index.js';
import { createPay, testProvider } from '../../pay/index.js';
import { createStages } from '../../stages/index.js';
import { createNotify, outbox } from '../../notify/index.js';
import { createCheckout } from '../index.js';

/** A market: two farms, a delivery fee per farm, orders split by farm, a counting provider. */
export async function market({ store = memoryStore(), provider = testProvider(), stock = { eggs: 5, beef: 20 } } = {}) {
  await store.write('items', 'hill/eggs', { name: 'Eggs', unit: 'dozen', cents: 600, left: stock.eggs });
  await store.write('items', 'vale/beef', { name: 'Beef', unit: 'lb', cents: 899, left: stock.beef });
  const charges = [];
  const counted = { charge: async (charge) => (charges.push(charge), provider.charge(charge)) };
  const catalog = createCatalog({ store });
  const cart = createCart({ store, catalog });
  const pay = createPay({ provider: counted, store });
  const stages = createStages({ store, collection: 'orders', steps: ['placed', 'claimed', 'picked', 'delivered'], owner: 'driver', now: () => 7 });
  const mail = outbox();
  const notify = createNotify({ send: mail.send, templates: { placed: ({ key, cents }) => ({ subject: 'Thanks', body: `${key}: ${cents}` }) } });
  const farmOf = (line) => line.item.split('/')[0];
  const checkout = createCheckout({
    store,
    catalog,
    cart,
    pay,
    stages,
    notify,
    group: farmOf,
    fees: ({ lines }) => [...new Set(lines.map(farmOf))].map((farm) => ({ label: 'Delivery', cents: 400, group: farm })),
    now: () => 9,
  });
  return { store, catalog, cart, pay, stages, checkout, charges, mail };
}

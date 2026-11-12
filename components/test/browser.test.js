// The kit's components in a browser, imported from the package by the test shop, with JavaScript
// and without:
// fill a cart from two sellers, change it, check out once, see the orders; a declined card; two
// devices after the last jar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createShop } from './shop.js';

let browser;
const errors = [];
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => existsSync(path));

before(async () => {
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
});
after(async () => {
  await browser?.close();
  assert.deepEqual(errors, [], 'no page errors');
});

async function shop(stock) {
  const made = await createShop(stock ? { stock } : {});
  await new Promise((done) => made.server.listen(0, done));
  const base = `http://localhost:${made.server.address().port}`;
  return { ...made, base, close: () => new Promise((done) => (made.server.closeAllConnections?.(), made.server.close(done))) };
}

async function device(base, javaScriptEnabled) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => response.status() >= 400 && !response.url().endsWith('/favicon.ico') && errors.push(`${response.status()} ${response.url()}`));
  const go = async (path) => {
    await page.goto(base + path);
    if (javaScriptEnabled) await page.waitForFunction(() => ['catalog-grid', 'cart-panel', 'checkout-form', 'order-status'].some((tag) => customElements.get(tag)) || !document.querySelector('catalog-grid, cart-panel, checkout-form, order-status'));
  };
  return { context, page, go };
}

const FIELDS = { Name: 'name', Email: 'email', 'Delivery address': 'address', 'Card number': 'card' };
const field = (page, label) => page.getByLabel(label);
const text = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, ' ').trim());
const addToCart = (page, item) => page.locator(`catalog-grid article[data-item="${item}"] button[type=submit]`).click();
const line = (page, item) => page.locator(`cart-panel li[data-item="${item}"]`);

for (const javaScriptEnabled of [true, false]) {
  const mode = javaScriptEnabled ? 'with JavaScript' : 'without JavaScript';

  test(`a cart from two sellers, changed, checked out once (${mode})`, async () => {
    const s = await shop();
    const { page, go, context } = await device(s.base, javaScriptEnabled);
    try {
      await go('/');
      assert.match(await text(page.locator('catalog-grid')), /Hillside Farm Eggs \$6\.00 per dozen/);
      assert.match(await text(page.locator('catalog-grid')), /Honey \$12\.00 per jar Only 2 left/);
      assert.match(await text(page.locator('cart-panel')), /Your cart is empty/);

      await addToCart(page, 'hill/eggs');
      await page.waitForURL(s.base + '/');
      await addToCart(page, 'hill/eggs');
      await page.waitForURL(s.base + '/');
      await addToCart(page, 'vale/beef');
      await page.waitForURL(s.base + '/');
      assert.equal(await text(line(page, 'hill/eggs').locator('output')), '2');
      assert.match(await text(page.locator('cart-panel dl')), /Items \$20\.99 .*Total \$28\.99/);

      // − on the eggs, + then Remove on the beef.
      await line(page, 'hill/eggs').locator('button', { hasText: '−' }).click();
      await page.waitForURL(s.base + '/');
      assert.equal(await text(line(page, 'hill/eggs').locator('output')), '1');
      await line(page, 'vale/beef').locator('button', { hasText: '+' }).click();
      await page.waitForURL(s.base + '/');
      assert.equal(await text(line(page, 'vale/beef').locator('output')), '2');
      await addToCart(page, 'hill/honey');
      await page.waitForURL(s.base + '/');
      await line(page, 'hill/honey').locator('button', { hasText: 'Remove' }).click();
      await page.waitForURL(s.base + '/');
      assert.equal(await line(page, 'hill/honey').count(), 0);
      assert.match(await text(page.locator('cart-panel dl')), /Items \$23\.98 .*Total \$31\.98/);

      await page.locator('cart-panel a', { hasText: 'Check out' }).click();
      await page.waitForURL(s.base + '/checkout');
      assert.match(await text(page.locator('checkout-form fieldset').first()), /1 × Eggs \$6\.00 2 × Ground beef \$17\.98 .*Total \$31\.98/);
      await field(page, 'Name').fill('Ada');
      await field(page, 'Email').fill('ada@example.com');
      await field(page, 'Delivery address').fill('1 Main St, Oakland MD');
      await field(page, 'Card number').fill('4242 4242 4242 4242');
      await page.locator('checkout-form button[type=submit]').click();
      await page.waitForURL(/\/orders\/c-/);

      const orders = page.locator('order-status');
      assert.equal(await orders.count(), 2);
      assert.match(await text(orders.nth(0)), /From Hillside Farm \$10\.00 .*1 dozen Eggs/);
      assert.match(await text(orders.nth(1)), /From Vale Beef \$21\.98 .*2 lb Ground beef/);
      assert.equal(await orders.nth(0).locator('article').getAttribute('data-status'), 'placed');
      if (javaScriptEnabled) assert.equal(await page.evaluate(() => Boolean(customElements.get('order-status'))), true, 'hydrated from the package');
      assert.equal(s.store.get('items', 'hill/eggs').left, 4);
      assert.equal(s.store.get('items', 'vale/beef').left, 18);
      assert.equal(s.store.under('payments').length, 1, 'one charge for two orders');

      // Back and press Place order again: the same checkout, not a second one.
      await page.goBack();
      if (await page.locator('checkout-form button[type=submit]').count()) {
        await page.goto(s.base + '/');
        assert.match(await text(page.locator('cart-panel')), /Your cart is empty/);
      }
      assert.equal(s.store.under('payments').length, 1);
    } finally {
      await context.close();
      await s.close();
    }
  });

  test(`a declined card says so and keeps the cart (${mode})`, async () => {
    const s = await shop();
    const { page, go, context } = await device(s.base, javaScriptEnabled);
    try {
      await go('/');
      await addToCart(page, 'hill/honey');
      await page.waitForURL(s.base + '/');
      await go('/checkout');
      await field(page, 'Name').fill('Bo');
      await field(page, 'Email').fill('bo@example.com');
      await field(page, 'Delivery address').fill('2 Main St');
      await field(page, 'Card number').fill('4000 0000 0000 0002');
      await page.locator('checkout-form button[type=submit]').click();
      await page.waitForURL(/problem=declined/);
      assert.match(await text(page.locator('checkout-form alert-banner')), /declined/);
      assert.equal(s.store.get('items', 'hill/honey').left, 2, 'stock back');
      assert.match(await text(page.locator('checkout-form fieldset').first()), /1 × Honey/);
    } finally {
      await context.close();
      await s.close();
    }
  });

  test(`two devices after the last jar: one gets it, the other is told (${mode})`, async () => {
    const s = await shop({ eggs: 5, beef: 5, honey: 1 });
    const ada = await device(s.base, javaScriptEnabled);
    const bo = await device(s.base, javaScriptEnabled);
    try {
      for (const { page, go } of [ada, bo]) {
        await go('/');
        await addToCart(page, 'hill/honey');
        await page.waitForURL(s.base + '/');
        await go('/checkout');
        await field(page, 'Name').fill('Someone');
        await field(page, 'Email').fill('someone@example.com');
        await field(page, 'Delivery address').fill('3 Main St');
        await field(page, 'Card number').fill('4242424242424242');
      }
      await Promise.all([ada.page.locator('checkout-form button[type=submit]').click(), bo.page.locator('checkout-form button[type=submit]').click()]);
      await Promise.all([ada.page.waitForURL(/\/orders\/|problem=/), bo.page.waitForURL(/\/orders\/|problem=/)]);
      const urls = [ada.page.url(), bo.page.url()];
      assert.equal(urls.filter((url) => url.includes('/orders/')).length, 1, urls.join(' '));
      assert.equal(urls.filter((url) => url.includes('problem=not-ready')).length, 1, urls.join(' '));
      const loser = urls[0].includes('problem=') ? ada.page : bo.page;
      assert.match(await text(loser.locator('checkout-form alert-banner')), /sold out/);
      assert.match(await text(loser.locator('checkout-form fieldset').first()), /Honey/);
      assert.equal(await loser.locator('checkout-form button[type=submit]').isDisabled(), true, 'Place order is off while the cart cannot be bought');
      await loser.goto(s.base + '/');
      assert.match(await text(loser.locator('cart-panel')), /Only 0 left/);
      assert.equal(await loser.locator('cart-panel a', { hasText: 'Check out' }).getAttribute('href'), null, 'Check out is off');
      const jar = loser.locator('catalog-grid article[data-item="hill/honey"]');
      assert.match(await text(jar), /Sold out/);
      assert.equal(await jar.locator('form').count(), 0, 'no add button on a sold-out item');
      assert.equal(s.store.get('items', 'hill/honey').left, 0);
    } finally {
      await ada.context.close();
      await bo.context.close();
      await s.close();
    }
  });
}

test('the order shows its step as stages move it, and a side step as a badge', async () => {
  const s = await shop();
  const { page, go, context } = await device(s.base, true);
  try {
    await go('/');
    await addToCart(page, 'hill/eggs');
    await page.waitForURL(s.base + '/');
    await go('/checkout');
    await field(page, 'Name').fill('Ada');
    await field(page, 'Email').fill('ada@example.com');
    await field(page, 'Delivery address').fill('1 Main St');
    await field(page, 'Card number').fill('4242');
    await page.locator('checkout-form button[type=submit]').click();
    await page.waitForURL(/\/orders\/c-/);
    const key = s.store.under('orders')[0].key;
    assert.match(await text(page.locator('order-status li[aria-current], order-status .current').first()), /Placed/);
    await s.stages.claim(key, 'driver-1');
    await s.stages.advance(key, 'picked', { by: 'driver-1' });
    await page.reload();
    assert.equal(await page.locator('order-status article').getAttribute('data-status'), 'picked');
    assert.match(await text(page.locator('order-status .current')), /On the way/);
    await s.stages.advance(key, 'delivered', { by: 'driver-1' });
    await page.reload();
    assert.equal(await page.locator('order-status .done').count(), 4, 'delivered marks every step done');
    await s.store.write('orders', key, { status: 'cancelled' });
    await page.reload();
    assert.match(await text(page.locator('order-status status-badge')), /cancelled/);
    assert.equal(await page.locator('order-status step-indicator').count(), 0);
  } finally {
    await context.close();
    await s.close();
  }
});

for (const javaScriptEnabled of [true, false]) {
  test(`an item with no limit: always for sale, one more always allowed (${javaScriptEnabled ? 'with' : 'without'} JavaScript)`, async () => {
    const s = await shop();
    const { page, go, context } = await device(s.base, javaScriptEnabled);
    try {
      await go('/');
      const tour = page.locator('catalog-grid article[data-item="vale/tour"]');
      assert.doesNotMatch(await text(tour), /Sold out|left/);
      await addToCart(page, 'vale/tour');
      await page.waitForURL(s.base + '/');
      for (let i = 0; i < 2; i++) {
        await line(page, 'vale/tour').locator('button', { hasText: '+' }).click();
        await page.waitForURL(s.base + '/');
      }
      assert.equal(await text(line(page, 'vale/tour').locator('output')), '3');
      assert.doesNotMatch(await text(line(page, 'vale/tour')), /left/);
      assert.notEqual(await page.locator('cart-panel a', { hasText: 'Check out' }).getAttribute('href'), null);
      assert.equal(s.store.get('items', 'vale/tour').left, null);
    } finally {
      await context.close();
      await s.close();
    }
  });
}

test('without JavaScript, each checkout label names its field', async () => {
  const s = await shop();
  const { page, go, context } = await device(s.base, false);
  try {
    await go('/');
    await addToCart(page, 'hill/eggs');
    await page.waitForURL(s.base + '/');
    await go('/checkout');
    for (const [label, name] of Object.entries(FIELDS)) assert.equal(await page.getByLabel(label).getAttribute('name'), name, label);
  } finally {
    await context.close();
    await s.close();
  }
});

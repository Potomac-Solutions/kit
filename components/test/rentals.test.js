// The booking components in a browser, imported from the package by the test outfitter, with
// JavaScript and without: kayaks for two days, all or nothing across days, a declined card, and
// seats at a showing seen from two devices.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createRentals } from './rentals.js';

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

async function outfitter() {
  const made = await createRentals();
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
    if (javaScriptEnabled) await page.waitForFunction(() => ['slot-picker', 'seat-map'].some((tag) => customElements.get(tag)));
  };
  return { context, page, go };
}

const text = (locator) => locator.evaluate((node) => node.innerText.replace(/\s+/g, ' ').trim());
const day = (page, pool) => page.locator(`slot-picker label[data-pool="${pool}"]`);
const seat = (page, id) => page.locator(`seat-map button[value="${id}"]`);

async function pickDays(page, base, pools, count) {
  for (const pool of pools) await day(page, pool).locator('input').check();
  await page.locator('slot-picker input[name=count]').fill(String(count));
  await page.locator('slot-picker button[type=submit]').click();
  await page.waitForURL(/\/rent/);
}

async function pay(page, card = '4242 4242 4242 4242') {
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Card number').fill(card);
  await page.locator('checkout-form button[type=submit]').click();
}

for (const javaScriptEnabled of [true, false]) {
  const mode = javaScriptEnabled ? 'with JavaScript' : 'without JavaScript';

  test(`two kayaks Friday and Saturday: held, priced by day, booked once (${mode})`, async () => {
    const o = await outfitter();
    const { page, go, context } = await device(o.base, javaScriptEnabled);
    try {
      await go('/rent');
      assert.match(await text(day(page, o.DAYS[0])), /Fri, Nov 20 3 free/);
      await pickDays(page, o.base, o.DAYS.slice(0, 2), 2);
      const summary = page.locator('booking-summary');
      assert.match(await text(summary), /Fri, Nov 20 · Kayak k1 \$40\.00 .*Sat, Nov 21 · Kayak k2 \$50\.00 Total \$180\.00/);
      assert.equal(await day(page, o.DAYS[0]).locator('input').isChecked(), true, 'held days stay ticked');

      await summary.locator('a', { hasText: 'Book' }).click();
      await page.waitForURL(/\/book\//);
      assert.match(await text(page.locator('checkout-form fieldset').first()), /Total \$180\.00/);
      await pay(page);
      await page.waitForURL(/\/bookings\//);
      assert.match(await text(page.locator('order-status')), /Your booking \$180\.00/);
      assert.equal(await page.locator('order-status article').getAttribute('data-status'), 'booked');
      assert.equal(o.store.under('payments').length, 1);
      for (const pool of o.DAYS.slice(0, 2)) for (const unit of ['k1', 'k2']) assert.equal(o.holds.taken(pool).get(unit).state, 'taken');

      await go('/rent');
      assert.match(await text(day(page, o.DAYS[0])), /1 free/);
      assert.equal(await page.locator('booking-summary section').count(), 0, 'nothing held now');
    } finally {
      await context.close();
      await o.close();
    }
  });

  test(`Friday to Sunday when Saturday is full: refused, and nothing held (${mode})`, async () => {
    const o = await outfitter();
    await o.reserve.hold('someone', { key: 'x', pools: [o.DAYS[1]], count: 3, from: ['k1', 'k2', 'k3'] });
    const { page, go, context } = await device(o.base, javaScriptEnabled);
    try {
      await go('/rent');
      assert.match(await text(day(page, o.DAYS[1])), /None free/);
      assert.equal(await day(page, o.DAYS[1]).locator('input').isDisabled(), true, 'a full day cannot be ticked');
      // Ask for Friday and Sunday with two kayaks, then Saturday fills: pick against the full day.
      await o.reserve.release('someone', 'x');
      await go('/rent');
      await o.reserve.hold('someone', { key: 'x', pools: [o.DAYS[1]], count: 3, from: ['k1', 'k2', 'k3'] });
      await pickDays(page, o.base, o.DAYS.slice(0, 3), 1);
      assert.match(page.url(), /problem=none-free/);
      assert.match(await text(page.locator('[role=alert]')), /Not that many free/);
      assert.equal(o.holds.taken(o.DAYS[0]).size, 0, 'Friday was not held');
      assert.equal(await page.locator('booking-summary section').count(), 0);
    } finally {
      await context.close();
      await o.close();
    }
  });

  test(`seats from two devices: held shows as held, let go frees it, booked shows as taken (${mode})`, async () => {
    const o = await outfitter();
    const ada = await device(o.base, javaScriptEnabled);
    const bo = await device(o.base, javaScriptEnabled);
    try {
      await ada.go('/cinema');
      await seat(ada.page, 'A1').click();
      await ada.page.waitForURL(/\/cinema/);
      await seat(ada.page, 'A2').click();
      await ada.page.waitForURL(/\/cinema/);
      assert.equal(await seat(ada.page, 'A1').getAttribute('aria-pressed'), 'true');
      assert.match(await text(ada.page.locator('booking-summary')), /7:30 pm · Seat A1 \$11\.00 .*Total \$22\.00/);

      await bo.go('/cinema');
      assert.equal(await seat(bo.page, 'A1').getAttribute('data-state'), 'held');
      assert.equal(await seat(bo.page, 'A1').isDisabled(), true);
      assert.equal(await seat(bo.page, 'A1').getAttribute('aria-label'), 'Seat A1, being held');

      await seat(ada.page, 'A2').click(); // let go of one
      await ada.page.waitForURL(/\/cinema/);
      assert.match(await text(ada.page.locator('booking-summary')), /Total \$11\.00/);
      await ada.page.locator('booking-summary a', { hasText: 'Book' }).click();
      await ada.page.waitForURL(/\/book\//);
      await pay(ada.page);
      await ada.page.waitForURL(/\/bookings\//);

      await bo.go('/cinema');
      assert.equal(await seat(bo.page, 'A1').getAttribute('data-state'), 'taken');
      assert.equal(await seat(bo.page, 'A2').getAttribute('data-state'), 'free');
      await seat(bo.page, 'A2').click();
      await bo.page.waitForURL(/\/cinema/);
      await bo.page.locator('booking-summary button', { hasText: 'Let go' }).click();
      await bo.page.waitForURL(/\/cinema/);
      assert.equal(await seat(bo.page, 'A2').getAttribute('data-state'), 'free');
      assert.equal(await bo.page.locator('booking-summary section').count(), 0);
    } finally {
      await ada.context.close();
      await bo.context.close();
      await o.close();
    }
  });
}

test('a declined card keeps the hold, says so, and can be paid again', async () => {
  const o = await outfitter();
  const { page, go, context } = await device(o.base, false);
  try {
    await go('/rent');
    await pickDays(page, o.base, [o.DAYS[3]], 1);
    await page.locator('booking-summary a', { hasText: 'Book' }).click();
    await page.waitForURL(/\/book\//);
    await pay(page, '4000 0000 0000 0002');
    await page.waitForURL(/problem=declined/);
    assert.match(await text(page.locator('checkout-form alert-banner')), /declined/);
    assert.equal(o.holds.taken(o.DAYS[3]).get('k1').state, 'held');
    await pay(page);
    await page.waitForURL(/\/bookings\//);
    assert.equal(o.holds.taken(o.DAYS[3]).get('k1').state, 'taken');
  } finally {
    await context.close();
    await o.close();
  }
});

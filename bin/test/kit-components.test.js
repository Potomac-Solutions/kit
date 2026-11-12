import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, check, components } from '../kit-components.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'kit-components-'));

test('the kit components are the four, not the Zubra UI parts it carries', () => {
  assert.deepEqual(components, ['cart-panel', 'catalog-grid', 'checkout-form', 'order-status']);
});

test('add copies the components and the parts they use, marked with the kit version', () => {
  const to = folder();
  const { wrote, kept } = add(['cart-panel'], to);
  assert.deepEqual(wrote, ['cart-panel', 'action-button', 'empty-state', 'status-badge']);
  assert.deepEqual(kept, []);
  assert.match(readFileSync(join(to, 'cart-panel.zb'), 'utf8'), /^<!-- From @potomac-solutions\/kit \d+\.\d+\.\d+ \(components\/cart-panel\.zb\)/);
  assert.deepEqual(readdirSync(to).sort(), ['action-button.zb', 'cart-panel.zb', 'empty-state.zb', 'status-badge.zb']);
});

test("the app's own Zubra UI parts are kept", () => {
  const to = folder();
  writeFileSync(join(to, 'action-button.zb'), '<!-- the app’s own -->');
  const { kept } = add([], to);
  assert.deepEqual(kept, ['action-button']);
  assert.equal(readFileSync(join(to, 'action-button.zb'), 'utf8'), '<!-- the app’s own -->');
  assert.deepEqual(Object.fromEntries(check(to).map(({ name, state }) => [name, state]))['action-button'], 'own');
});

test('check tells a current copy from a changed one and an older one', () => {
  const to = folder();
  add(['order-status'], to);
  const path = join(to, 'order-status.zb');
  assert.equal(check(to).find((c) => c.name === 'order-status').state, 'current');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n<!-- edited -->');
  assert.equal(check(to).find((c) => c.name === 'order-status').state, 'changed');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/kit \S+ /, 'kit 0.0.1 '));
  assert.equal(check(to).find((c) => c.name === 'order-status').state, 'older');
});

test('an unknown name is refused, naming the ones there are', () => {
  assert.throws(() => add(['seat-map'], folder()), /No kit component called seat-map\. There are: cart-panel/);
});

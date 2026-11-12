// Mutation check: break one behaviour at a time and confirm a test notices.
// A mutation that leaves the suite green means that behaviour is untested.
//
//   node scripts/mutate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mutations = [
  ['hold', 'the taken-unit guard', "if (!mine.has(unit) && all.has(unit)) return { error: 'taken', unit };", ''],
  ['hold', 'expiry on read', "doc?.state === 'held' && doc.until <= at ? FREE", 'false ? FREE'],
  ['hold', 'the sweep', "filter((doc) => doc.state === 'held' && doc.until <= at)", 'filter(() => false)'],
  ['hold', 'the ceiling', 'if (ceilingMs) until = Math.min(until, since + ceilingMs);', ''],
  ['hold', 'the limit', "if (want.size > max) return { error: 'limit', max, unit: toggle };", ''],
  ['stages', 'one claimant', "if (record[owner]) return { error: 'claimed', by: record[owner], yours: record[owner] === who };", ''],
  ['stages', 'step order', "if (!allowedFrom(to).includes(record[field])) return { error: 'wrong-step', at: record[field] };", ''],
  ['stages', 'who may advance', "if (!may({ record, to, by })) return { error: 'refused' };", ''],
  ['pay', 'charge once', "if (before?.state === 'pending') return { error: 'in-progress' };", ''],
  ['pay', 'no second charge after success', "if (before?.state === 'paid') return { ok: true, ref: before.ref, again: true };", ''],
  ['price', 'range end is exclusive', 'have < want.to', 'have <= want.to'],
  ['price', 'the floor at zero', 'Math.max(0, cents)', 'cents'],
  ['tenant', 'www and port stripped', ".replace(/^www\\./, '')", ''],
  ['tenant', 'theme values checked', '!VALUE.test(value) ||', ''],
  ['auth', 'the signature check', 'if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;', ''],
  ['files', 'ids are checked', "!ID.test(id ?? '') ||", ''],
  ['files', 'the type allow-list', "if (!Object.hasOwn(types, type ?? '')) return { error: 'type' };", ''],
  ['notify', 'a failing sender is caught', "result = { error: 'sender-failed', detail: String(error?.message ?? error) };", 'throw error;'],
  ['catalog', 'take is all or nothing', "if (short(item, qty)) return { error: 'sold-out', item: key, left: item.left };", ''],
  ['catalog', 'two lines of one item add up', '(want.get(line.item) ?? 0) + line.qty', 'line.qty'],
  ['catalog', 'unlisted items are not for sale', ' || !listed(key, doc)) return null;', ') return null;'],
  ['catalog', 'sold-out items leave the shelf', 'item && (all || stocked(item))', 'item'],
  ['catalog', 'restock adds', 'Math.max(0, Math.floor(Number(doc[left]) || 0)) + qty', 'qty'],
  ['cart', 'no more than is left', "if (found.left !== null && found.left < qty) return { error: 'sold-out', item, left: found.left };", ''],
  ['cart', 'the limit', "if (qty > max) return { error: 'too-many', max };", ''],
  ['cart', 'clear keeps what was added since', 'Math.max(0, (now[item] ?? 0) - qty)', '0'],
  ['cart', 'a short line makes the cart not ready', 'lines.length > 0 && ok.length === lines.length', 'lines.length > 0'],
  ['checkout', 'a paid checkout is not charged again', "if (before.state === 'paid') return { ok: true, again: true, key, orders: before.orders, ref: before.ref };", ''],
  ['checkout', 'a pending checkout is not run twice', "if (before.state === 'pending') return { error: 'in-progress' };", ''],
  ['checkout', 'another owner cannot use a checkout', "if (before.owner !== owner) return { error: 'not-yours' };", ''],
  ['checkout', 'a cart that cannot be bought is refused', "if (!quoted.ready) return { error: 'not-ready', lines: quoted.lines.filter((line) => line.gone || line.short) };", ''],
  ['checkout', 'a declined card puts the stock back', 'await catalog.restock(lines);', ''],
  ['checkout', 'the bought lines leave the cart', 'cart.clear(owner, lines)', 'Promise.resolve()'],
  ['checkout', 'a fee with no group goes on the first order only', "one.group === undefined ? i === 0", "one.group === undefined ? true"],
  ['catalog', 'put refuses a bad count', "if (left in fields && fields[left] !== null && (!Number.isInteger(fields[left]) || fields[left] < 0)) return { error: 'bad-qty' };", ''],
  ['catalog', 'a new item needs a name and a price', "if (!store.get(collection, key) && !('name' in fields && 'cents' in fields)) return { error: 'incomplete' };", ''],
  ['catalog', 'active: false is off sale', "doc.active === false || ", ''],
  ['catalog', 'null is no limit', 'left: count === null ? null : Math.max', 'left: Math.max'],
  ['catalog', 'take leaves no limit alone', 'if (item.left !== null) after.push', 'after.push'],
  ['catalog', 'restock leaves no limit alone', "if (!doc || doc[left] === null || ", "if (!doc || "],
  ['cart', 'no limit is never short', 'short: found.left !== null && found.left < qty', 'short: found.left < qty'],
  ['checkout', 'fees see the fields', 'fees({ lines, cents: view.cents, context, fields })', 'fees({ lines, cents: view.cents, context, fields: {} })'],
  ['store', 'syncStore lists in key order', '.sort(byKey),\n', ',\n'],
];

// Components, against the browser tests (`npm run mutate -- --components`, slower).
const components = [
  ['catalog-grid', 'a sold-out item has no add button', 'zb-if={add && item.left > 0}', 'zb-if={add}'],
  ['cart-panel', 'checking out is off while a line cannot be bought', 'disabled={!cart.ready}>Check out', 'disabled={false}>Check out'],
  ['checkout-form', 'placing the order is off while the cart cannot be bought', 'disabled={!cart.ready}>Place order', 'disabled={false}>Place order'],
  ['checkout-form', 'the checkout key is sent', 'name="checkout" value={checkout}', 'name="checkout" value=""'],
  ['order-status', 'the last step marks every step done', 'at === steps.length - 1 ? steps.length : at', 'at'],
  ['order-status', 'a side step shows as a badge', 'zb-if={at < 0 && status}', 'zb-if={false}'],
];
const browser = process.argv.includes('--components');

let missed = 0;
for (const [module, what, find, replace] of browser ? components : mutations) {
  const path = browser ? `${root}components/${module}.zb` : `${root}modules/${module}/index.js`;
  const source = readFileSync(path, 'utf8');
  if (source.split(find).length !== 2) {
    console.log(`??   ${module}: ${what} (the line to break was not found exactly once)`);
    missed++;
    continue;
  }
  writeFileSync(path, source.replace(find, replace));
  let caught;
  try {
    caught = spawnSync(process.execPath, browser ? ['--test', '--test-concurrency=1', 'components/test/*.test.js'] : ['--test', 'modules/**/*.test.js', 'bin/**/*.test.js'], { cwd: root, encoding: 'utf8' }).status !== 0;
  } finally {
    writeFileSync(path, source);
  }
  console.log(`${caught ? 'ok  ' : 'MISS'} ${module}: ${what}`);
  if (!caught) missed++;
}
const total = (browser ? components : mutations).length;
console.log(missed ? `\n${missed} of ${total} not caught` : `\nall ${total} caught`);
process.exit(missed ? 1 : 0);

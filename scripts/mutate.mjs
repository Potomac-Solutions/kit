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
  ['catalog', 'all or nothing', '      if (refused) return Promise.resolve(refused);\n', ''],
  ['catalog', 'none left is gone', ' || leftOf(item) === 0) return', ') return'],
  ['catalog', 'hidden items are not for sale', "item.active !== false &&", ''],
  ['catalog', 'a new item needs a name and a price', "if (!read(key) && !('name' in fields && 'cents' in fields)) return { error: 'incomplete' };", ''],
  ['catalog', 'no limit stays no limit', "if (item && Number.isInteger(qty) && qty > 0 && leftOf(item) !== Infinity)", "if (item && Number.isInteger(qty) && qty > 0)"],
  ['cart', 'counts what is already in the cart', "const had = linesOf(holder).find((line) => line.item === item)?.qty ?? 0;", 'const had = 0;'],
  ['cart', 'the subtotal leaves out what cannot be had', '.filter((line) => !line.problem).reduce', '.reduce'],
  ['cart', 'a changed line is in place', "lines.splice(at < 0 ? lines.length : at, 0, { item, qty });", 'lines.push({ item, qty });'],
  ['checkout', 'the cart is emptied before anything is awaited', "const emptied = cart.clear(holder);\n      const [took] = await Promise.all([taken, emptied]);", "const [took] = await Promise.all([taken]);\n      await cart.clear(holder);"],
  ['checkout', 'a changed cart is refused', "if (!quoted.ok) return { error: 'changed', lines: quoted.lines };", ''],
  ['checkout', 'a failed payment gives the stock back', '        await catalog.give(taking);\n', ''],
  ['checkout', 'a failed payment puts the lines back', "const had = cart.lines(holder).find((line) => line.item === item)?.qty ?? 0;", 'const had = -qty;'],
  ['checkout', 'one order per group', "const key = many ? `${checkoutId}-${order.group}` : checkoutId;", 'const key = checkoutId;'],
  ['notify', 'a failing sender is caught', "result = { error: 'sender-failed', detail: String(error?.message ?? error) };", 'throw error;'],
];

let missed = 0;
for (const [module, what, find, replace] of mutations) {
  const path = `${root}modules/${module}/index.js`;
  const source = readFileSync(path, 'utf8');
  if (source.split(find).length !== 2) {
    console.log(`??   ${module}: ${what} (the line to break was not found exactly once)`);
    missed++;
    continue;
  }
  writeFileSync(path, source.replace(find, replace));
  let caught;
  try {
    caught = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8' }).status !== 0;
  } finally {
    writeFileSync(path, source);
  }
  console.log(`${caught ? 'ok  ' : 'MISS'} ${module}: ${what}`);
  if (!caught) missed++;
}
console.log(missed ? `\n${missed} of ${mutations.length} not caught` : `\nall ${mutations.length} caught`);
process.exit(missed ? 1 : 0);

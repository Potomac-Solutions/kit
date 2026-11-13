// Mutation check: break one behaviour at a time and confirm a test notices.
// A mutation that leaves the suite green means that behaviour is untested.
//
//   node scripts/mutate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mutations = [
  ['hold', 'the taken-unit guard', "if (!mine.has(unit) && all.has(unit)) return { error: 'taken', unit, pool };", ''],
  ['hold', 'expiry on read', "doc?.state === 'held' && doc.until <= at ? FREE", 'false ? FREE'],
  ['hold', 'the sweep', "filter((doc) => doc.state === 'held' && doc.until <= at)", 'filter(() => false)'],
  ['hold', 'the ceiling', 'if (ceilingMs) until = Math.min(until, since + ceilingMs + (ceiling ? 0 : ms));', ''],
  ['hold', 'the limit', "if (want.size > max) return { error: 'limit', max, unit: asked, pool };", ''],
  ['stages', 'one claimant', "if (record[owner]) return { error: 'claimed', by: record[owner], yours: record[owner] === who };", ''],
  ['stages', 'step order', "if (!allowedFrom(to).includes(record[field])) return { error: 'wrong-step', at: record[field] };", ''],
  ['stages', 'who may advance', "if (!may({ record, to, by })) return { error: 'refused' };", ''],
  ['pay', 'charge once', "if (before?.state === 'pending') return { error: 'in-progress' };", ''],
  ['pay', 'no second charge after success', "        return { ok: true, ref: before.ref, again: true };\n", ''],
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
  ['hold', 'chooseAcross checks every pool before writing', "      if (checked.error) return checked;\n      plans.push(checked);", "      plans.push(checked);"],
  ['hold', 'a payment window is not cut by the ceiling', '...(ms ? { ms, ceiling: false } : {})', '...(ms ? { ms } : {})'],
  ['hold', 'confirm with units needs every one still held', "if (lost.length) return { error: 'not-held', units: lost };", ''],
  ['hold', 'confirm with units keeps the rest held', 'const rest = live.units.filter((unit) => !mine.includes(unit));', 'const rest = [];'],
  ['reserve', 'count picks units free on every day', 'busy.every((taken) =>', 'busy.some((taken) =>'],
  ['reserve', 'not enough free is refused', "if (open.length < count) return { error: 'none-free', left: open.length };", ''],
  ['reserve', 'dropped days are let go', '...dropped.map((pool) => ({ pool, units: [] }))', ''],
  ['reserve', 'a lapsed hold is refused before the charge', "if (lost.length) return { error: 'lapsed', pool, units: lost };", ''],
  ['reserve', 'holds are kept through the payment', 'holds.chooseAcross(holder, mine, { ms: payMs })', 'holds.chooseAcross(holder, mine)'],
  ['reserve', 'a pending booking is not booked twice', "if (booking.state === 'pending') return { error: 'in-progress' };\n      if (booking.state === 'released')", "if (booking.state === 'released')"],
  ['reserve', 'a paid booking is not charged again', "if (booking.state === 'paid') return { ok: true, again: true, key, ref: booking.ref, cents: booking.cents };", ''],
  ['reserve', 'a released booking cannot be booked', "if (booking.state === 'released') return { error: 'released' };", ''],
  ['reserve', 'a lost unit after payment is not started', 'if (lost) {', 'if (false) {'],
  ['reserve', "another holder's booking is refused", "if (booking.holder !== holder) return { error: 'not-yours' };\n    if (booking.state === 'paid') return { error: 'booked' };", "if (booking.state === 'paid') return { error: 'booked' };"],
  ['reserve', 'price rules see the pool', '{ ...context(pool), pool, unit }', '{ pool, unit }'],
  ['reserve', "a hold is only mine if it's the holder's", "holder && now.by === holder ? 'mine' : 'held'", "'mine'"],
  ['reserve', 'a day counts my own units as free', "one.state === 'free' || one.state === 'mine'", "one.state === 'free'"],
  ['tenancy', 'a business is opened once', 'if (!spaces.has(tenant.id)) {', 'if (true) {'],
  ['tenancy', 'a failed open is tried again', 'opening.catch(() => spaces.delete(tenant.id));', 'opening.catch(() => {});'],
  ['tenancy', 'an unknown host gets nothing (Node)', "const tenant = tenants.for(req);\n      if (!tenant) {", "const tenant = tenants.for(req) ?? tenants.all()[0];\n      if (!tenant) {"],
  ['tenancy', 'an unknown host gets nothing (fetch)', "const tenant = tenants.for(request);\n      if (!tenant) return notYours();", "const tenant = tenants.for(request) ?? tenants.all()[0];\n      if (!tenant) return notYours();"],
  ['tenancy', 'sync requests are routed', 'path === base || path.startsWith(`${base}/`)', 'false'],
  ['tenancy', "setup's features are on the space", 'return Object.assign(space, await setup(space));', 'return space;'],
  ['tenancy', 'open must give a Sync server', "if (typeof sync?.documents !== 'function' || typeof sync.write !== 'function') throw new TypeError(`open(${tenant.id}) must return a Sync server`);", ''],
  ['store', 'syncStore lists in key order', '.sort(byKey),\n', ',\n'],
  ['pay', 'a paid id for another amount is refused', "if (before.cents !== cents || (before.currency ?? 'usd') !== currency) return { error: 'paid-other-amount' };", ''],
  ['checkout', "a checkout's payment id is its own", 'id: `checkout/${key}`', 'id: key'],
  ['reserve', "a booking's payment id is its own", 'id: `booking/${key}`', 'id: key'],
  ['store', "serverOnly refuses a page's changes", "asked.kind === 'change' && only.has(asked.collection) ? false : next(asked)", 'next(asked)'],
  ['hold', "a deeper pool's units aren't this pool's", "if (doc.key.slice(pool.length + 1).includes('/')) continue;", ''],
  ['hold', "a unit can't name a pool", "!unit || unit.includes('/') || ", ''],
  ['hold', 'a payment window runs past the ceiling only once', 'since + ceilingMs + (ceiling ? 0 : ms)', '(ceiling ? since + ceilingMs : Infinity)'],
  ['hold', 'a limit by default', 'max = 8,', 'max = Infinity,'],
  ['hold', 'a ceiling by default', 'ceilingMs = 20 * 60_000,', 'ceilingMs = 0,'],
  ['stages', "side steps need the app's may", 'steps.includes(to) && record[owner]', 'record[owner]'],
  ['stages', 'no one advances without a name', 'Boolean(by) && steps', 'steps'],
  ['reserve', 'pools the business never offers are refused', "if (unknown) return { error: 'unknown-pool', pool: unknown };", ''],
  ['store', 'pages never see staff accounts', 'secret.has(asked.collection) ? false : ', ''],
  ['staff', "a fresh session id at every sign-in", "const id = token();", "const id = 'A'.repeat(43);"],
  ['staff', "an ended or expired session is nobody", "if (!session || session.ended || session.until <= now()) return null;", "if (!session) return null;"],
  ['staff', "a turned-off account's session is nobody", "if (!account || account.disabled) return null;\n    return { ...view", "if (!account) return null;\n    return { ...view"],
  ['staff', "the lockout", "if (failed && failed.until > now() && failed.count >= tries) return { error: 'locked', until: failed.until };", ""],
  ['staff', "a turned-off account can't sign in", "&& Boolean(account) && !account.disabled;", "&& Boolean(account);"],
  ['staff', "a link works once", "!found.used && ", ""],
  ['staff', "a link expires", "found.until > now() ? { key, ...found }", "true ? { key, ...found }"],
  ['staff', "the setup link only while there is nobody", "if (accounts().length) return null;\n      return issue('invite'", "return issue('invite'"],
  ['staff', "two links at once make one account", "        if (byEmail(email)) return { error: 'Someone already has an account with that email.' };\n        if (!found.email && accounts().length) return { error: 'That link has expired or been used. Ask for a new one.' };\n        account =", "        account ="],
  ['staff', "the invite says the email", "found.email || cleanEmail(form.email)", "cleanEmail(form.email) || found.email"],
  ['staff', "only an owner invites", "if (!isOwner(fresh(by))) return { error: 'Only an owner can invite people.' };", ""],
  ['staff', "an owner is checked as stored, not as claimed", "const fresh = (who) => (who?.account ? view({ key: who.account, ...store.get('accounts', who.account) }) : null);", "const fresh = (who) => who;"],
  ['staff', "the last owner keeps the role", "!given.includes(OWNER) && !found.disabled && owners().length <= 1", "false"],
  ['staff', "the last owner stays on", "if (disabled && found.roles.includes(OWNER) && !found.disabled && owners().length <= 1)", "if (false)"],
  ['staff', "turning someone off ends their sessions", "if (disabled) await this.endSessions(account);", ""],
  ['staff', "a reset ends every session", "        await store.write('accounts', account, { hash, changedAt: now() });\n        await this.endSessions(account);", "        await store.write('accounts', account, { hash, changedAt: now() });"],
  ['staff', "changing a password needs the current one", "if (!(await checkPassword(String(current ?? ''), account.hash))) return { error: 'Your current password isn\u2019t right.' };", ""],
  ['staff', "passwords have a minimum length", "password.length < minPassword", "password.length < 1"],
  ['staff', "an unknown email costs a password check", "account?.hash ?? (await decoy)", "account?.hash ?? ''"],
  ['staff', "the key comparison", "actual.length === expected.length && timingSafeEqual(actual, expected)", "true"],
  ['staff', "the cookie is HttpOnly", "; Path=/; HttpOnly; SameSite=Lax", "; Path=/; SameSite=Lax"],
  ['staff', "__Host- over https", "secure ? `__Host-${name}` : name", "name"],
  ['staff', "emails are compared lower-case", "String(email ?? '').trim().toLowerCase()", "String(email ?? '').trim()"],
];

// Components, against the browser tests (`npm run mutate -- --components`, slower).
const components = [
  ['catalog-grid', 'a sold-out item has no add button', 'zb-if={add && item.left !== 0}', 'zb-if={add}'],
  ['catalog-grid', 'an item with no limit is never sold out', 'zb-if={item.left === 0}', 'zb-if={item.left <= 0}'],
  ['cart-panel', 'an item with no limit can always have one more', '(line.left !== null && line.qty >= line.left)', 'line.qty >= line.left'],
  ['cart-panel', 'checking out is off while a line cannot be bought', 'disabled={!cart.ready}>Check out', 'disabled={false}>Check out'],
  ['checkout-form', 'placing the order is off while the cart cannot be bought', 'disabled={!cart.ready}>Place order', 'disabled={false}>Place order'],
  ['checkout-form', 'the checkout key is sent', 'name="checkout" value={checkout}', 'name="checkout" value=""'],
  ['order-status', 'the last step marks every step done', 'at === steps.length - 1 ? steps.length : at', 'at'],
  ['slot-picker', 'a full day cannot be picked', 'disabled={day.free === 0 && !day.mine}', 'disabled={false}'],
  ['slot-picker', 'days already held stay ticked', 'checked={day.mine}', 'checked={false}'],
  ['seat-map', "seats held by others can't be pressed", "disabled={seat.state === 'held' || seat.state === 'taken'}", "disabled={seat.state === 'taken'}"],
  ['seat-map', 'your seats are pressed', "aria-pressed={seat.state === 'mine' ? 'true' : 'false'}", "aria-pressed=\"false\""],
  ['booking-summary', 'shows only a booking that is held', "const live = booking.state === 'held' || booking.state === 'failed'", 'const live = true'],
  ['booking-summary', 'the total', 'money(booking.cents ?? 0)', 'money(0)'],
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
    caught = spawnSync(process.execPath, browser ? ['--test', '--test-concurrency=1', 'components/test/*.test.js'] : ['--test', 'modules/**/*.test.js'], { cwd: root, encoding: 'utf8' }).status !== 0;
  } finally {
    writeFileSync(path, source);
  }
  console.log(`${caught ? 'ok  ' : 'MISS'} ${module}: ${what}`);
  if (!caught) missed++;
}
const total = (browser ? components : mutations).length;
console.log(missed ? `\n${missed} of ${total} not caught` : `\nall ${total} caught`);
process.exit(missed ? 1 : 0);

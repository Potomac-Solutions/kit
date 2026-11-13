import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../../store/index.js';
import { createStaff, hashPassword, checkPassword, STAFF_COLLECTIONS } from '../index.js';

// Cheap hashing for tests; the stored hash says its own cost, so checks still work.
const cost = { N: 2 ** 10, r: 8, p: 1 };
const clock = (start = 1_800_000_000_000) => {
  let t = start;
  const now = () => t;
  now.add = (ms) => (t += ms);
  return now;
};
const idOf = (cookie) => cookie.split(';')[0].split('=')[1];
const req = (cookie) => ({ headers: { cookie: cookie ? cookie.split(';')[0] : '' } });

/** A business with an owner, Rosa, signed in. */
async function business(options = {}) {
  const store = memoryStore();
  const now = options.now ?? clock();
  const staff = createStaff({ store, cost, now, ...options });
  const setup = await staff.setup();
  const made = await staff.accept(setup, { email: 'Rosa@Example.com ', name: 'Rosa Bittinger', password: 'correct horse battery' });
  assert.equal(made.ok, true, JSON.stringify(made));
  const rosa = staff.session(req(made.cookie));
  return { store, staff, now, rosa, rosaCookie: made.cookie };
}

test('the first owner comes from a setup link, which works once and only while there is nobody', async () => {
  const store = memoryStore();
  const staff = createStaff({ store, cost, now: clock() });
  assert.equal(staff.needsOwner(), true);
  const first = await staff.setup();
  const second = await staff.setup();
  assert.deepEqual(staff.peek(first), { kind: 'invite', email: '', name: '', setup: true });
  assert.deepEqual(await staff.accept(first, { email: 'not an email', name: 'Rosa', password: 'correct horse battery' }), { error: 'Give your email address.' });
  const made = await staff.accept(first, { email: 'rosa@example.com', name: 'Rosa', password: 'correct horse battery' });
  assert.equal(made.ok, true);
  assert.match(made.cookie, /^staff=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  assert.deepEqual(staff.session(req(made.cookie)).roles, ['owner']);
  assert.equal(staff.needsOwner(), false);
  assert.equal(await staff.setup(), null, 'no more setup links');
  assert.match((await staff.accept(first, { email: 'x@example.com', name: 'X', password: 'correct horse battery' })).error, /expired or been used/);
  assert.match((await staff.accept(second, { email: 'eve@example.com', name: 'Eve', password: 'correct horse battery' })).error, /expired or been used/, 'a second setup link made earlier is dead too');
  assert.equal(staff.list().length, 1);
});

test('two setup links, or one link, used at the same moment make one owner', async () => {
  const store = memoryStore();
  const staff = createStaff({ store, cost, now: clock() });
  const [a, b] = [await staff.setup(), await staff.setup()];
  const answers = await Promise.all([
    staff.accept(a, { email: 'rosa@example.com', name: 'Rosa', password: 'correct horse battery' }),
    staff.accept(b, { email: 'eve@example.com', name: 'Eve', password: 'correct horse battery' }),
    staff.accept(a, { email: 'mallory@example.com', name: 'Mallory', password: 'correct horse battery' }),
  ]);
  assert.equal(answers.filter((answer) => answer.ok).length, 1, JSON.stringify(answers));
  assert.equal(staff.list().length, 1);
});

test('signing in: one answer for a wrong password or an unknown email; a fresh session every time', async () => {
  const { staff } = await business();
  assert.deepEqual(await staff.signIn('rosa@example.com', 'wrong password!'), { error: 'wrong' });
  assert.deepEqual(await staff.signIn('nobody@example.com', 'correct horse battery'), { error: 'wrong' });
  const one = await staff.signIn('  ROSA@example.com', 'correct horse battery');
  const two = await staff.signIn('rosa@example.com', 'correct horse battery');
  assert.equal(one.ok && two.ok, true);
  assert.notEqual(idOf(one.cookie), idOf(two.cookie));
  assert.deepEqual(staff.session(req(one.cookie)), { ...staff.session(req(one.cookie)), name: 'Rosa Bittinger', email: 'rosa@example.com', roles: ['owner'], disabled: false });
  // An unknown email costs a password check too, so timing doesn't say whether it exists.
  const time = async (email) => {
    const started = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) await staff.signIn(email, `nope${i}xxxxxxxx`);
    return Number(process.hrtime.bigint() - started);
  };
  const known = await time('rosa2@example.com'.replace('2', ''));
  const unknown = await time('ghost@example.com');
  assert.ok(unknown > known * 0.4, `unknown ${unknown} vs known ${known}`);
});

test('a session cookie: forged, malformed, expired or ended is nobody', async () => {
  const now = clock();
  const { staff, rosaCookie } = await business({ now });
  assert.ok(staff.session(req(rosaCookie)));
  assert.equal(staff.session(req('staff=' + 'A'.repeat(43))), null, 'a guess');
  assert.equal(staff.session(req('staff=../../etc')), null);
  assert.equal(staff.session(req('staff=')), null);
  assert.equal(staff.session({ headers: {} }), null);
  assert.deepEqual(staff.session(rosaCookie.split(';')[0]), staff.session(req(rosaCookie)), 'a Cookie header string works too');
  assert.ok(staff.session(new Request('http://x/', { headers: { cookie: rosaCookie.split(';')[0] } })), 'and a fetch Request');
  now.add(12 * 3_600_000);
  assert.equal(staff.session(req(rosaCookie)), null, 'expired');
  const again = await staff.signIn('rosa@example.com', 'correct horse battery');
  const out = await staff.signOut(req(again.cookie));
  assert.match(out.cookie, /^staff=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
  assert.equal(staff.session(req(again.cookie)), null, 'signed out');
});

test('nothing secret is stored: no password, session id or link token in the log', async () => {
  const { store, staff, rosaCookie } = await business();
  const { token } = await staff.invite(staff.session(req(rosaCookie)), { email: 'sam@example.com', roles: ['staff'] });
  const everything = JSON.stringify(STAFF_COLLECTIONS.map((collection) => store.under(collection)));
  for (const secret of ['correct horse battery', idOf(rosaCookie), token]) assert.ok(!everything.includes(secret), secret);
  assert.match(store.under('accounts')[0].hash, /^scrypt\$1024\$8\$1\$/);
});

test('too many wrong passwords lock the email for a while, even for the right password', async () => {
  const now = clock();
  const { staff } = await business({ now, tries: 3, lockMs: 60_000 });
  assert.deepEqual(await staff.signIn('rosa@example.com', 'wrong one 1'), { error: 'wrong' });
  assert.deepEqual(await staff.signIn('rosa@example.com', 'wrong one 2'), { error: 'wrong' });
  assert.equal((await staff.signIn('rosa@example.com', 'wrong one 3')).error, 'locked');
  assert.equal((await staff.signIn('rosa@example.com', 'correct horse battery')).error, 'locked');
  now.add(60_001);
  assert.equal((await staff.signIn('rosa@example.com', 'correct horse battery')).ok, true);
  // A success clears the count.
  await staff.signIn('rosa@example.com', 'wrong one 1');
  await staff.signIn('rosa@example.com', 'correct horse battery');
  assert.deepEqual(await staff.signIn('rosa@example.com', 'wrong one 2'), { error: 'wrong' });
  assert.deepEqual(await staff.signIn('rosa@example.com', 'wrong one 3'), { error: 'wrong' });
});

test('an owner invites people with roles; only an owner can; an invite works once and expires', async () => {
  const now = clock();
  const { staff, rosa } = await business({ now });
  assert.deepEqual(await staff.invite(rosa, { email: 'nope', roles: ['staff'] }), { error: 'Give their email address.' });
  assert.deepEqual(await staff.invite(rosa, { email: 'sam@example.com', roles: ['admin'] }), { error: 'Choose what they can do.' });
  assert.deepEqual(await staff.invite(rosa, { email: 'sam@example.com', roles: [] }), { error: 'Choose what they can do.' });
  assert.deepEqual(await staff.invite(rosa, { email: 'ROSA@example.com', roles: ['staff'] }), { error: 'Someone already has an account with that email.' });
  const { token } = await staff.invite(rosa, { email: 'Sam@Example.com', name: 'Sam', roles: ['staff'] });
  assert.deepEqual(staff.peek(token), { kind: 'invite', email: 'sam@example.com', name: 'Sam', setup: false });
  assert.deepEqual(await staff.accept(token, { name: 'Sam', password: 'short' }), { error: 'Use at least 10 characters.' });
  assert.deepEqual(await staff.accept(token, { name: 'Sam', password: 'sam@example.com' }), { error: 'Don’t use your email as your password.' });
  const sam = await staff.accept(token, { name: 'Sam Teets', password: 'another long one', email: 'evil@example.com' });
  assert.equal(sam.ok, true);
  const samSession = staff.session(req(sam.cookie));
  assert.equal(samSession.email, 'sam@example.com', 'the invite says the email, not the form');
  assert.deepEqual(samSession.roles, ['staff']);
  assert.match((await staff.accept(token, { name: 'Again', password: 'another long one' })).error, /expired or been used/);
  // Staff can't invite, and can't act as owner.
  assert.deepEqual(await staff.invite(samSession, { email: 'eve@example.com', roles: ['owner'] }), { error: 'Only an owner can invite people.' });
  assert.equal(staff.can(samSession, 'staff'), true);
  assert.equal(staff.can(samSession, 'owner'), false);
  assert.equal(staff.can(rosa, 'staff'), true, 'an owner can do anything');
  assert.equal(staff.can(null, 'staff'), false);
  // A claimed session can't stand in for an owner: `by` is checked against the account as stored.
  assert.deepEqual(await staff.invite({ ...samSession, roles: ['owner'] }, { email: 'eve@example.com', roles: ['owner'] }), { error: 'Only an owner can invite people.' });
  // Expired.
  const late = (await staff.invite(rosa, { email: 'late@example.com', roles: ['staff'] })).token;
  now.add(7 * 86_400_000 + 1);
  assert.equal(staff.peek(late), null);
  assert.match((await staff.accept(late, { name: 'Late', password: 'another long one' })).error, /expired/);
  // A link that isn't one.
  assert.equal(staff.peek('x'), null);
  assert.match((await staff.accept('A'.repeat(43), { name: 'X', password: 'another long one' })).error, /expired/);
});

test('a reset link sets a new password once, and ends every session the person had', async () => {
  const { staff, rosa } = await business();
  const { token } = await staff.invite(rosa, { email: 'sam@example.com', roles: ['staff'] });
  const sam = await staff.accept(token, { name: 'Sam', password: 'first password' });
  const phone = await staff.signIn('sam@example.com', 'first password');
  const samSession = staff.session(req(sam.cookie));
  assert.deepEqual(await staff.resetLink(samSession, samSession.account), { error: 'Only an owner can do that.' });
  const reset = await staff.resetLink(rosa, samSession.account);
  assert.deepEqual(staff.peek(reset.token), { kind: 'reset', email: 'sam@example.com', name: 'Sam', setup: false });
  const done = await staff.accept(reset.token, { password: 'second password', email: 'evil@example.com', name: 'Evil' });
  assert.equal(done.ok, true);
  assert.equal(staff.session(req(sam.cookie)), null, 'old sessions end');
  assert.equal(staff.session(req(phone.cookie)), null);
  assert.equal(staff.session(req(done.cookie)).name, 'Sam', 'a reset changes only the password');
  assert.deepEqual(await staff.signIn('sam@example.com', 'first password'), { error: 'wrong' });
  assert.equal((await staff.signIn('sam@example.com', 'second password')).ok, true);
  assert.match((await staff.accept(reset.token, { password: 'third password' })).error, /expired or been used/);
});

test('the business always keeps an owner; turning someone off ends their sessions at once', async () => {
  const { staff, rosa } = await business();
  assert.match((await staff.setRoles(rosa, rosa.account, ['staff'])).error, /needs an owner/);
  assert.match((await staff.setDisabled(rosa, rosa.account, true)).error, /needs an owner/);
  const { token } = await staff.invite(rosa, { email: 'sam@example.com', roles: ['staff'] });
  const sam = await staff.accept(token, { name: 'Sam', password: 'first password' });
  const samId = staff.session(req(sam.cookie)).account;
  assert.deepEqual(await staff.setRoles(rosa, samId, ['owner', 'staff']), { ok: true });
  assert.deepEqual(staff.session(req(sam.cookie)).roles, ['owner', 'staff'], 'roles apply to an open session at once');
  assert.deepEqual(await staff.setRoles(rosa, rosa.account, ['staff']), { ok: true }, 'now there is another owner');
  assert.deepEqual(await staff.setRoles(rosa, samId, ['staff']), { error: 'Only an owner can do that.' }, 'Rosa is no longer an owner');
  const samNow = staff.session(req(sam.cookie));
  assert.deepEqual(await staff.setDisabled(samNow, rosa.account, true), { ok: true });
  assert.deepEqual(await staff.signIn('rosa@example.com', 'correct horse battery'), { error: 'wrong' }, 'a turned-off account can’t sign in');
  assert.equal(staff.session({ headers: { cookie: '' } }), null);
  assert.equal(staff.list().find((one) => one.email === 'rosa@example.com').disabled, true);
  assert.deepEqual(await staff.setDisabled(samNow, rosa.account, false), { ok: true });
  assert.equal((await staff.signIn('rosa@example.com', 'correct horse battery')).ok, true);
  assert.deepEqual(await staff.setRoles(samNow, 'a-nobody', ['staff']), { error: 'That isn’t one of your staff.' });
});

test('turning someone off ends a session they already have', async () => {
  const { staff, rosa } = await business();
  const { token } = await staff.invite(rosa, { email: 'sam@example.com', roles: ['staff'] });
  const sam = await staff.accept(token, { name: 'Sam', password: 'first password' });
  assert.ok(staff.session(req(sam.cookie)));
  const samId = staff.session(req(sam.cookie)).account;
  await staff.setDisabled(rosa, samId, true);
  assert.equal(staff.session(req(sam.cookie)), null);
  // Switched back on, the old session stays ended: they sign in again.
  await staff.setDisabled(rosa, samId, false);
  assert.equal(staff.session(req(sam.cookie)), null);
});

test('a session of an account turned off some other way is nobody, even if it was never ended', async () => {
  const { store, staff, rosa } = await business();
  const { token } = await staff.invite(rosa, { email: 'sam@example.com', roles: ['staff'] });
  const sam = await staff.accept(token, { name: 'Sam', password: 'first password' });
  await store.write('accounts', staff.session(req(sam.cookie)).account, { disabled: true });
  assert.equal(staff.session(req(sam.cookie)), null);
});

test('changing your own password needs the current one, and ends your other sessions', async () => {
  const { staff, rosaCookie } = await business();
  const phone = await staff.signIn('rosa@example.com', 'correct horse battery');
  const rosa = staff.session(req(rosaCookie));
  assert.deepEqual(await staff.changePassword(rosa, 'wrong', 'a brand new one'), { error: 'Your current password isn’t right.' });
  assert.deepEqual(await staff.changePassword(rosa, 'correct horse battery', 'short'), { error: 'Use at least 10 characters.' });
  assert.deepEqual(await staff.changePassword(rosa, 'correct horse battery', 'a brand new one'), { ok: true });
  assert.ok(staff.session(req(rosaCookie)), 'this session stays');
  assert.equal(staff.session(req(phone.cookie)), null, 'the phone is signed out');
  assert.equal((await staff.signIn('rosa@example.com', 'a brand new one')).ok, true);
});

test('over https the cookie is __Host- and Secure; options are checked', async () => {
  const { rosaCookie, staff } = await business({ secure: true });
  assert.match(rosaCookie, /^__Host-staff=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  assert.equal(staff.cookieName, '__Host-staff');
  assert.equal(staff.session(req(rosaCookie.replace('__Host-staff', 'staff'))), null, 'the plain name is not read');
  assert.throws(() => createStaff({}), /needs a store/);
  assert.throws(() => createStaff({ store: memoryStore(), roles: ['staff'] }), /must include "owner"/);
  assert.throws(() => createStaff({ store: memoryStore(), name: 'a;b' }), /cookie name/);
});

test('password hashes: salted, checked in constant time, cost kept with the hash', async () => {
  const a = await hashPassword('the same password', cost);
  const b = await hashPassword('the same password', cost);
  assert.notEqual(a, b);
  assert.equal(await checkPassword('the same password', a), true);
  assert.equal(await checkPassword('the same passworD', a), false);
  assert.equal(await checkPassword('x', 'not a hash'), false);
  assert.equal(await checkPassword('x', ''), false);
  // Unicode is compared after NFKC, so the same password typed two ways matches.
  assert.equal(await checkPassword('café au lait', await hashPassword('café au lait', cost)), true);
});

test('a flood of made-up emails doesn’t keep growing what the lockout remembers', async () => {
  const now = clock();
  const { staff } = await business({ now, lockMs: 1000, cost: { N: 2 ** 4, r: 1, p: 1 } });
  for (let i = 0; i < 10_000; i++) await staff.signIn(`ghost${i}@example.com`, 'whatever xx');
  assert.equal(staff.remembered(), 10_000);
  now.add(1001);
  await staff.signIn('another@example.com', 'whatever xx');
  assert.equal(staff.remembered(), 1, 'the expired ones were forgotten');
});

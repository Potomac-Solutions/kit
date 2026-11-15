import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, serverOnly, SECRET } from '../../store/index.js';
import { createCustomers, CUSTOMER_COLLECTIONS } from '../index.js';

const cost = { N: 2 ** 10, r: 8, p: 1 };
const make = (options = {}) => {
  const store = memoryStore();
  return { store, customers: createCustomers({ store, cost, ...options }) };
};
const header = (cookie) => cookie.split(';')[0];

test('sign up makes an account and signs it in', async () => {
  const { customers, store } = make();
  const made = await customers.signUp({ email: ' Ann@Example.com ', name: ' Ann Baker ', password: 'correct horse battery' });
  assert.ok(made.ok);
  assert.match(made.cookie, /^account=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.deepEqual(customers.session(header(made.cookie)), { customer: made.customer, name: 'Ann Baker', email: 'ann@example.com', disabled: false, at: store.get('customers', made.customer).at });
  const stored = store.get('customers', made.customer);
  assert.match(stored.hash, /^scrypt\$/);
  assert.ok(!JSON.stringify(store.under('customer-sessions')).includes(header(made.cookie).split('=')[1]), 'the session id itself is never stored');
});

test('sign up refuses a bad email, no name, a short password, the email as password, and a second account', async () => {
  const { customers } = make();
  assert.match((await customers.signUp({ email: 'nope', name: 'A', password: 'correct horse battery' })).error, /email/);
  assert.match((await customers.signUp({ email: 'a@example.com', name: ' ', password: 'correct horse battery' })).error, /name/);
  assert.match((await customers.signUp({ email: 'a@example.com', name: 'A', password: 'short' })).error, /at least 10/);
  assert.match((await customers.signUp({ email: 'a@example.com', name: 'A', password: 'A@example.com' })).error, /email as your password/);
  assert.ok((await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' })).ok);
  assert.match((await customers.signUp({ email: 'A@EXAMPLE.COM', name: 'B', password: 'another long password' })).error, /already an account/);
  assert.equal(customers.list().length, 1);
});

test('sign in, sign out, and a wrong password or unknown email get the same answer', async () => {
  const { customers } = make();
  await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' });
  assert.deepEqual(await customers.signIn('a@example.com', 'wrong password!'), { error: 'wrong' });
  assert.deepEqual(await customers.signIn('nobody@example.com', 'correct horse battery'), { error: 'wrong' });
  const signed = await customers.signIn('A@example.com', 'correct horse battery');
  assert.ok(signed.ok);
  assert.ok(customers.session(header(signed.cookie)));
  const out = await customers.signOut(header(signed.cookie));
  assert.equal(out.cookie, 'account=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  assert.equal(customers.session(header(signed.cookie)), null, 'a signed-out session is over');
});

test('five wrong tries from one device lock that device out, even with the right password', async () => {
  const { customers } = make();
  await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' });
  for (let i = 0; i < 4; i++) assert.deepEqual(await customers.signIn('a@example.com', `guess ${i} wrong`, { client: '1.2.3.4' }), { error: 'wrong' });
  assert.deepEqual(await customers.signIn('a@example.com', 'guess 5 wrong', { client: '1.2.3.4' }), { error: 'locked' });
  assert.deepEqual(await customers.signIn('a@example.com', 'correct horse battery', { client: '1.2.3.4' }), { error: 'locked' });
  assert.ok((await customers.signIn('a@example.com', 'correct horse battery', { client: '5.6.7.8' })).ok, 'another device is not locked');
});

test('a session ends when its time is up', async () => {
  let at = 1_000_000;
  const { customers } = make({ now: () => at, sessionMs: 1000 });
  const made = await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' });
  assert.ok(customers.session(header(made.cookie)));
  at += 1001;
  assert.equal(customers.session(header(made.cookie)), null);
});

test('a reset link sets a new password once, ends other sessions, and runs out', async () => {
  let at = 1_000_000;
  const { customers } = make({ now: () => at, tokenMs: 60_000 });
  const made = await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' });
  assert.equal(await customers.resetToken('nobody@example.com'), null);
  const raw = await customers.resetToken('A@example.com');
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(customers.peek(raw), true);
  assert.match((await customers.reset(raw, 'short')).error, /at least 10/);
  const done = await customers.reset(raw, 'a brand new password');
  assert.ok(done.ok);
  assert.equal(customers.session(header(made.cookie)), null, 'the old session ended');
  assert.ok(customers.session(header(done.cookie)));
  assert.match((await customers.reset(raw, 'another new password')).error, /expired or been used/);
  assert.ok((await customers.signIn('a@example.com', 'a brand new password')).ok);

  const late = await customers.resetToken('a@example.com');
  at += 60_001;
  assert.equal(customers.peek(late), false);
  assert.match((await customers.reset(late, 'yet another password')).error, /expired/);
});

test('a turned-off account cannot sign in, keep a session, or reset', async () => {
  const { customers } = make();
  const made = await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' });
  const raw = await customers.resetToken('a@example.com');
  await customers.setDisabled(made.customer, true);
  assert.equal(customers.session(header(made.cookie)), null);
  assert.deepEqual(await customers.signIn('a@example.com', 'correct horse battery'), { error: 'wrong' });
  assert.equal(await customers.resetToken('a@example.com'), null);
  assert.match((await customers.reset(raw, 'a brand new password')).error, /expired/);
  await customers.setDisabled(made.customer, false);
  assert.ok((await customers.signIn('a@example.com', 'correct horse battery')).ok);
});

test('a customer can rename themselves; the list is newest first', async () => {
  let at = 1;
  const { customers } = make({ now: () => at++ });
  const a = await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' });
  await customers.signUp({ email: 'b@example.com', name: 'B', password: 'correct horse battery' });
  assert.deepEqual(await customers.rename(a.customer, '  '), { error: 'Give your name.' });
  assert.ok((await customers.rename(a.customer, 'Ann')).ok);
  assert.deepEqual(customers.list().map((c) => c.name), ['B', 'Ann']);
});

test('a forged or malformed cookie is nobody, and on https the cookie is __Host- and Secure', async () => {
  const { customers } = make({ secure: true });
  const made = await customers.signUp({ email: 'a@example.com', name: 'A', password: 'correct horse battery' });
  assert.match(made.cookie, /^__Host-account=.*; Secure$/);
  for (const bad of ['', '__Host-account=abc', `__Host-account=${'A'.repeat(43)}`, 'account=' + header(made.cookie).split('=')[1]]) {
    assert.equal(customers.session(bad), null, bad);
  }
});

test('pages can never read or write the customer collections', () => {
  for (const collection of CUSTOMER_COLLECTIONS) assert.ok(SECRET.includes(collection), collection);
  const authorize = serverOnly();
  for (const collection of CUSTOMER_COLLECTIONS) {
    assert.equal(authorize({ collection, op: 'read' }), false, collection);
  }
});

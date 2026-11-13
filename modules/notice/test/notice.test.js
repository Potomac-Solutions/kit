import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotices } from '../index.js';

const notices = createNotices({ secret: 'test secret' });
const read = (location) => notices.read(new URL(location, 'http://shop.example'));

test('a message the server signed shows; the same words typed into a link don’t', () => {
  const signed = notices.sign(`/order?problem=${encodeURIComponent('That time is taken.')}`);
  assert.match(signed, /^\/order\?problem=That\+time\+is\+taken\.&sig=[\w-]{22}$/);
  assert.deepEqual(read(signed), { problem: 'That time is taken.', done: '' });
  assert.deepEqual(read('/order?problem=Your+password+expired.+Call+555-0100.'), { problem: '', done: '' });
  assert.deepEqual(read('/order?problem=x&sig=AAAAAAAAAAAAAAAAAAAAAA'), { problem: '', done: '' });
});

test('changing a signed message, or adding one beside it, drops it', () => {
  const signed = notices.sign('/kitchen?done=Saved.');
  assert.deepEqual(read(signed.replace('Saved.', 'Call+us.')), { problem: '', done: '' });
  assert.deepEqual(read(`${signed}&problem=Call+us.`), { problem: '', done: '' });
  assert.deepEqual(read(signed.replace('done=', 'problem=')), { problem: '', done: '' }, 'a done is not a problem');
  // A line break can't move text from one kind of message to the other.
  const twoLines = notices.sign(`/?problem=${encodeURIComponent('a\nb')}`);
  const sig = new URL(twoLines, 'http://x').searchParams.get('sig');
  assert.deepEqual(read(`/?problem=a&done=${encodeURIComponent('b\n')}&sig=${sig}`), { problem: '', done: '' });
});

test('another secret’s signature doesn’t count', () => {
  const other = createNotices({ secret: 'someone else' });
  assert.deepEqual(read(other.sign('/?done=Hi.')), { problem: '', done: '' });
});

test('addresses without messages pass through; other query values and hashes are kept', () => {
  assert.equal(notices.sign('/kitchen'), '/kitchen');
  assert.equal(notices.sign('/show/7?seat=A1'), '/show/7?seat=A1');
  const signed = notices.sign('/show/7?seat=A1&done=Held.#seats');
  assert.match(signed, /^\/show\/7\?seat=A1&done=Held\.&sig=[\w-]+#seats$/);
  assert.equal(read(signed).done, 'Held.');
  assert.equal(notices.sign('https://shop.example/a?done=x').startsWith('https://shop.example/a?done=x&sig='), true);
});

test('a long message is cut before signing, so what shows is what was signed', () => {
  const signed = notices.sign(`/?problem=${'a'.repeat(500)}`);
  assert.equal(read(signed).problem, 'a'.repeat(200));
  assert.ok(signed.length < 260, 'the address carries only what will show');
  assert.equal(notices.sign(`/?problem=x&sig=old`).match(/sig=/g).length, 1, 'an old signature is replaced');
  assert.throws(() => createNotices({}), /secret/);
});

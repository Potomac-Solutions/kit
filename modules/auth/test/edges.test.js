// auth, notify and files: the three modules that are mostly an interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signedCookie } from '../index.js';
import { createNotify, outbox } from '../../notify/index.js';
import { memoryFiles, diskFiles } from '../../files/index.js';

test('auth: a newcomer gets a cookie, and comes back as the same person', () => {
  const auth = signedCookie({ secret: 's3cret', name: 'kit_guest' });
  const headers = {};
  const first = auth.ensure({ headers: {} }, { setHeader: (name, value) => (headers[name] = value) });
  assert.match(headers['set-cookie'], /^kit_guest=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  const cookie = headers['set-cookie'].split(';')[0];
  assert.deepEqual(auth.session(new Request('http://x/', { headers: { cookie: `other=1; ${cookie}` } })), first);
  assert.deepEqual(auth.ensure({ headers: { cookie } }, { setHeader: () => assert.fail('no new cookie') }), first);
  assert.notEqual(first.pub, first.id);
  assert.match(first.pub, /^[0-9a-f]{12}$/);
});

test('auth: a forged, altered or foreign cookie is nobody', () => {
  const auth = signedCookie({ secret: 's3cret' });
  const good = auth.cookie('abc').split(';')[0];
  assert.equal(auth.read(good).id, 'abc');
  assert.equal(auth.read(good.replace('abc', 'abd')), null, 'a changed id');
  assert.equal(auth.read(`${good}x`), null, 'a changed signature');
  assert.equal(auth.read('session=abc'), null, 'no signature');
  assert.equal(auth.read('session=%E0%A4%A'), null, 'not decodable');
  assert.equal(auth.read(signedCookie({ secret: 'other' }).cookie('abc')), null, "another secret's cookie");
  assert.equal(auth.read(''), null);
  assert.throws(() => signedCookie({}), /secret/);
});

test('auth: roles come from the app, and Secure is on when asked', () => {
  const auth = signedCookie({ secret: 's', secure: true, roles: (id) => (id === 'boss' ? ['manager'] : []) });
  assert.match(auth.cookie('boss'), /; Secure$/);
  assert.deepEqual(auth.read(auth.cookie('boss')).roles, ['manager']);
  assert.deepEqual(auth.read(auth.cookie('guest')).roles, []);
});

test('notify: a template is sent on every address the person has', async () => {
  const box = outbox();
  const { notify } = createNotify({ send: box.send, templates: { ready: ({ name, what }) => ({ subject: 'Ready for pickup', body: `${name}, your ${what} is ready.` }) } });
  const answer = await notify({ sms: '+13015550100', email: 'pat@example.com' }, 'ready', { name: 'Pat', what: 'order' });
  assert.equal(answer.ok, true);
  assert.deepEqual(box.sent, [
    { channel: 'sms', to: '+13015550100', subject: 'Ready for pickup', body: 'Pat, your order is ready.' },
    { channel: 'email', to: 'pat@example.com', subject: 'Ready for pickup', body: 'Pat, your order is ready.' },
  ]);
  assert.deepEqual(await notify({}, 'ready', {}), { error: 'no-address' });
  await assert.rejects(() => notify({ sms: '+1' }, 'nope'), /No template/);
});

test('notify: one sender failing does not lose the other, and all failing is an error', async () => {
  const send = async ({ channel }) => (channel === 'sms' ? Promise.reject(new Error('carrier down')) : { ok: true });
  const { notify } = createNotify({ send, templates: { hi: () => ({ body: 'hi' }) } });
  assert.deepEqual(await notify({ sms: '+1', email: 'a@b.example' }, 'hi'), { ok: true, results: [{ channel: 'sms', error: 'sender-failed' }, { channel: 'email', ok: true }] });
  assert.deepEqual(await notify({ sms: '+1' }, 'hi'), { error: 'not-sent', results: [{ channel: 'sms', error: 'sender-failed' }] });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test('files: the same picture is one file; type, size and emptiness are checked', async () => {
  for (const make of [() => memoryFiles({ maxBytes: 10 }), (dir) => diskFiles(dir, { maxBytes: 10 })]) {
    const dir = mkdtempSync(join(tmpdir(), 'kit-files-'));
    try {
      const files = make(dir);
      const { id } = await files.put({ type: 'image/png', body: PNG });
      assert.match(id, /^[0-9a-f]{64}\.png$/);
      assert.equal((await files.put({ type: 'image/png', body: PNG })).id, id);
      const back = await files.get(id);
      assert.equal(back.type, 'image/png');
      assert.deepEqual(new Uint8Array(back.body), PNG);
      assert.deepEqual(await files.put({ type: 'image/svg+xml', body: PNG }), { error: 'type' });
      assert.deepEqual(await files.put({ type: 'constructor', body: PNG }), { error: 'type' });
      assert.deepEqual(await files.put({ type: 'image/png', body: new Uint8Array(0) }), { error: 'empty' });
      assert.deepEqual(await files.put({ type: 'image/png', body: 'not bytes' }), { error: 'empty' });
      assert.deepEqual(await files.put({ type: 'image/png', body: new Uint8Array(11) }), { error: 'too-big', maxBytes: 10 });
      assert.equal(await files.get('0'.repeat(64) + '.png'), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('files: a path can not be smuggled in as an id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-files-'));
  try {
    const files = diskFiles(join(dir, 'kept'));
    await files.put({ type: 'image/png', body: PNG });
    for (const id of ['../secret.png', '..%2Fsecret.png', '/etc/passwd', `${'a'.repeat(64)}.png/../../x`, '', undefined]) assert.equal(await files.get(id), null);
    assert.equal(readdirSync(join(dir, 'kept')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

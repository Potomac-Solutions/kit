// auth, notify and files: the three modules that are mostly an interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { signedCookie, PRODUCTION } from '../index.js';
import { createNotices } from '../../notice/index.js';
import { createNotify, outbox } from '../../notify/index.js';
import { memoryFiles, diskFiles } from '../../files/index.js';

test('auth: a newcomer gets a cookie, and comes back as the same person', () => {
  const auth = signedCookie({ secret: 's3cret xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', name: 'kit_guest' });
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
  const auth = signedCookie({ secret: 's3cret xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
  const good = auth.cookie('abc').split(';')[0];
  assert.equal(auth.read(good).id, 'abc');
  assert.equal(auth.read(good.replace('abc', 'abd')), null, 'a changed id');
  assert.equal(auth.read(`${good}x`), null, 'a changed signature');
  assert.equal(auth.read('session=abc'), null, 'no signature');
  assert.equal(auth.read('session=%E0%A4%A'), null, 'not decodable');
  assert.equal(auth.read(signedCookie({ secret: 'other xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }).cookie('abc')), null, "another secret's cookie");
  assert.equal(auth.read(''), null);
  assert.throws(() => signedCookie({}), /secret/);
});

test('auth: roles come from the app, and Secure is on when asked', () => {
  const auth = signedCookie({ secret: 's xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', secure: true, roles: (id) => (id === 'boss' ? ['manager'] : []) });
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

// The PNG signature, then a few bytes: files checks that a declared image is one.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

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

test('files: a file declared as an image must be one', async () => {
  const files = memoryFiles();
  const page = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/avif']) assert.deepEqual(await files.put({ type, body: page }), { error: 'type' }, type);
  const real = {
    'image/png': PNG,
    'image/jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    'image/webp': new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '),
    'image/avif': new TextEncoder().encode('\0\0\0\x1cftypavif\0\0\0\0'),
  };
  for (const [type, body] of Object.entries(real)) assert.equal((await files.put({ type, body })).ok, true, type);
  // A type the app adds itself has no signature to check: the app's own allow-list decides.
  assert.equal((await memoryFiles({ types: { 'text/csv': 'csv' } }).put({ type: 'text/csv', body: page })).ok, true);
});

test('notify: a line break in an address or subject is never sent', async () => {
  const box = outbox();
  const notify = createNotify({ send: box.send, templates: { t: ({ subject }) => ({ subject, body: 'hi' }) } });
  assert.deepEqual(await notify.notify({ email: 'me@x.example\r\nBcc: all@x.example' }, 't', { subject: 'Hi' }), { error: 'not-sent', results: [{ channel: 'email', error: 'bad-header' }] });
  assert.deepEqual(await notify.notify({ email: 'me@x.example' }, 't', { subject: 'Hi\nBcc: x@y.example' }), { error: 'not-sent', results: [{ channel: 'email', error: 'bad-header' }] });
  assert.deepEqual(box.sent, []);
  assert.equal((await notify.notify({ email: 'me@x.example', sms: '+13015550100' }, 't', { subject: 'Ready' })).ok, true);
  assert.equal(box.sent.length, 2);
});

test('auth: a cookie stops working maxAge after it was signed, whatever the browser keeps', () => {
  let t = 1_000_000_000_000;
  const now = () => t;
  const auth = signedCookie({ secret: 'k'.repeat(32), maxAge: 100, now });
  const cookie = auth.cookie('abc').split(';')[0];
  t += 99_000;
  assert.equal(auth.read(cookie).id, 'abc');
  t += 2_000;
  assert.equal(auth.read(cookie), null, 'copied off a device and kept, it no longer signs anyone in');
  // A visitor who keeps coming is re-signed past half the time, and keeps their id.
  const fresh = auth.cookie('kept').split(';')[0];
  t += 60_000;
  let set = '';
  assert.equal(auth.ensure({ headers: { cookie: fresh } }, { setHeader: (_, value) => (set = value) }).id, 'kept');
  assert.match(set, /^session=kept\./);
  // The older form (no time) still names its id, and is re-signed.
  const mac = createHmac('sha256', 'k'.repeat(32)).update('old').digest('base64url');
  set = '';
  assert.equal(auth.ensure({ headers: { cookie: `session=old.${mac}` } }, { setHeader: (_, value) => (set = value) }).id, 'old');
  assert.match(decodeURIComponent(set), /^session=old\.[0-9a-z]+\./);
  // A time can't be moved: it is signed with the id.
  const [id, at, sig] = decodeURIComponent(cookie.split('=')[1]).split('.');
  assert.equal(auth.read(`session=${encodeURIComponent(`${id}.${(Number.parseInt(at, 36) + 50_000).toString(36)}.${sig}`)}`), null);
});

test('auth: a short secret is refused; secure cookies by default in production', () => {
  assert.throws(() => signedCookie({ secret: 'x'.repeat(31) }), /at least 32 characters/);
  assert.throws(() => createNotices({ secret: 'hunter2' }), /at least 32 characters/);
  assert.equal(PRODUCTION, process.env.NODE_ENV === 'production');
  const cookieIn = (env) => execFileSync(process.execPath, ['--input-type=module', '-e', `import { signedCookie } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}; console.log(signedCookie({ secret: 'k'.repeat(32) }).cookie('a'))`], { env: { ...process.env, NODE_ENV: env } }).toString();
  assert.match(cookieIn('production'), /; Secure/);
  assert.doesNotMatch(cookieIn('development'), /; Secure/);
});

// The staff pages over a real HTTP server: the routes, who may use them, and the headers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { memoryStore } from '../../store/index.js';
import { createStaff } from '../index.js';
import { staffPages } from '../pages.js';

const cost = { N: 2 ** 10, r: 8, p: 1 };
let server;
let base;
let staff;
let rendered = [];

before(async () => {
  staff = createStaff({ store: memoryStore(), cost });
  const pages = staffPages({ staff, home: '/kitchen', business: 'Hickory Hollow', render: (res, title, body) => (rendered.push(title), res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>${title}</title>${body}`)) });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let form = null;
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      form = new URLSearchParams(body);
    }
    if (await pages.handle(req, res, url, form)) return;
    const who = staff.session(req);
    if (url.pathname === '/kitchen') return res.writeHead(200).end(staff.can(who, 'staff') ? `KITCHEN ${pages.bar(who)}` : pages.signIn(url));
    res.writeHead(404).end('not ours');
  });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const send = (path, { form, cookie } = {}) =>
  fetch(`${base}${path}`, { method: form ? 'POST' : 'GET', redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
const cookieOf = (response) => response.headers.get('set-cookie')?.split(';')[0];
const words = async (response) => decodeURIComponent(response.headers.get('location') ?? '');

test('set up, invite, sign in and out, and the owner’s pages, through the routes', async () => {
  assert.match(await (await send('/kitchen')).text(), /Nobody has an account here yet/);
  const setup = await staff.setup();
  const page = await send(`/staff/accept?token=${setup}`);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Set up Hickory Hollow/);
  assert.match(await (await send('/staff/accept', { form: { token: setup, email: 'ma@example.com', name: 'Ma', password: 'short' } })).text(), /Use at least 10 characters/);
  const made = await send('/staff/accept', { form: { token: setup, email: 'ma@example.com', name: 'Ma Teets', password: 'kitchen owner password' } });
  assert.equal(await words(made), '/kitchen?done=You’re signed in.');
  const ma = cookieOf(made);
  assert.match(await (await send('/kitchen', { cookie: ma })).text(), /KITCHEN[\s\S]*Signed in as Ma Teets[\s\S]*People/);
  assert.equal((await send('/staff', { cookie: ma })).headers.get('location'), '/kitchen', '/staff itself goes home');

  const invited = await (await send('/staff/people/invite', { cookie: ma, form: { email: 'jo@example.com', name: 'Jo', role: 'staff' } })).text();
  const link = invited.match(/value="(http[^"]+)"/)[1];
  assert.match(link, /^http:\/\/localhost:\d+\/staff\/accept\?token=[A-Za-z0-9_-]{43}$/);
  const jo = cookieOf(await send('/staff/accept', { form: { token: new URL(link).searchParams.get('token'), name: 'Jo Friend', password: 'jo kitchen password' } }));
  assert.match(await (await send('/kitchen', { cookie: jo })).text(), /Signed in as Jo Friend/);
  assert.doesNotMatch(await (await send('/kitchen', { cookie: jo })).text(), /People/);
  // Staff are sent home from the owner's pages and posts.
  assert.equal((await send('/staff/people', { cookie: jo })).headers.get('location'), '/kitchen');
  assert.equal((await send('/staff/people/invite', { cookie: jo, form: { email: 'eve@example.com', role: 'owner' } })).headers.get('location'), '/kitchen');
  assert.equal((await send('/staff/people', {})).headers.get('location'), '/kitchen', 'and so is nobody');

  const joAccount = staff.list().find((one) => one.email === 'jo@example.com').account;
  assert.equal(await words(await send('/staff/people/off', { cookie: ma, form: { account: joAccount } })), '/staff/people?done=Done.');
  assert.match(await (await send('/kitchen', { cookie: jo })).text(), /Staff sign-in/, 'turned off: signed out');
  assert.equal(await words(await send('/staff/people/off', { cookie: ma, form: { account: staff.list().find((one) => one.email === 'ma@example.com').account } })), '/staff/people?problem=The business needs an owner. Make someone else an owner first.');

  assert.equal(await words(await send('/staff/sign-in', { form: { email: 'ma@example.com', password: 'nope nope nope' } })), '/kitchen?problem=That email and password don’t match.');
  const again = await send('/staff/sign-in', { form: { email: 'ma@example.com', password: 'kitchen owner password' } });
  assert.equal(again.headers.get('location'), '/kitchen');
  assert.equal(await words(await send('/staff/password', { cookie: cookieOf(again), form: { current: 'nope', next: 'a new long password' } })), '/staff/password?problem=Your current password isn’t right.');
  assert.equal(await words(await send('/staff/sign-out', { cookie: cookieOf(again), form: {} })), '/kitchen?done=Signed out.');
  assert.match(await (await send('/kitchen', { cookie: cookieOf(again) })).text(), /Staff sign-in/);
  assert.equal((await send('/staff/nothing', { cookie: ma })).status, 404, 'anything else is the app’s');
});

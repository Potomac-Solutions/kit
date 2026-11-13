// Two businesses on one deployment, each seeing only its own documents: through the kit's
// features, and through the sync routes their pages use (pull, push, live), over real HTTP, with
// a SQLite file each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncServer, memoryLog } from '@zubra/sync/server';
import { sqliteLog } from '@zubra/sync/sqlite';
import { createTenants } from '../../tenant/index.js';
import { createCatalog } from '../../catalog/index.js';
import { createHolds } from '../../hold/index.js';
import { createTenancy } from '../index.js';
import { serverOnly } from '../../store/index.js';

const TENANTS = [
  { id: 'hillside', name: 'Hillside Farm', hosts: ['hillside.test'] },
  { id: 'garrett8', name: 'Garrett 8 Cinema', hosts: ['garrett8.test'] },
];

async function deployment({ open } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-tenancy-'));
  const opened = [];
  const tenancy = createTenancy({
    tenants: createTenants({ tenants: TENANTS }),
    open:
      open ??
      (async (tenant) => {
        opened.push(tenant.id);
        // Pages may write their own notes; the kit's collections are the server's (`serverOnly`).
        return createSyncServer({ log: await sqliteLog(join(dir, `${tenant.id}.db`)), authorize: serverOnly() });
      }),
    setup: ({ store }) => ({ catalog: createCatalog({ store }), holds: createHolds({ store }) }),
  });
  const server = createServer(async (req, res) => {
    if (await tenancy.handle(req, res)) return;
    const space = await tenancy.space(req);
    if (!space) return res.writeHead(404).end('No business here');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ business: space.tenant.name, items: space.catalog.items() }));
  });
  await new Promise((done) => server.listen(0, done));
  const port = server.address().port;
  /** A request as a browser on `host` makes it. */
  const ask = (host, path, { method = 'GET', body } = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ port, path, method, headers: { host, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  /** The live stream on `host`, collecting whatever it sends. */
  const listen = (host) => {
    const got = [];
    const req = httpRequest({ port, path: '/_zb/sync/live?since=0&peer=t', headers: { host } }, (res) => res.on('data', (chunk) => got.push(String(chunk))));
    req.end();
    return { text: () => got.join(''), close: () => req.destroy() };
  };
  return { tenancy, dir, opened, ask, listen, close: () => new Promise((done) => (server.closeAllConnections(), server.close(done))) };
}

const clock = (n) => `${String(Date.now() + n).padStart(15, '0')}-00000-device`;
const keysOf = (changes) => [...new Set(changes.map((c) => `${c.collection}/${c.key}`))].sort();

test('the same key in two businesses is two documents, in two files', async () => {
  const d = await deployment();
  try {
    const farm = await d.tenancy.space('hillside.test');
    const cinema = await d.tenancy.space('garrett8.test');
    await farm.catalog.put('eggs', { name: 'Eggs', cents: 600, left: 5 });
    await cinema.catalog.put('eggs', { name: 'Egg rolls', cents: 450, left: 40 });
    assert.equal(farm.catalog.item('eggs').name, 'Eggs');
    assert.equal(cinema.catalog.item('eggs').name, 'Egg rolls');
    assert.ok(existsSync(join(d.dir, 'hillside.db')) && existsSync(join(d.dir, 'garrett8.db')), 'a file each');
    assert.deepEqual((await d.ask('hillside.test', '/')).json.items.map((i) => i.name), ['Eggs']);
    assert.deepEqual((await d.ask('www.garrett8.test', '/')).json.items.map((i) => i.name), ['Egg rolls'], 'every host of a business reaches it');
  } finally {
    await d.close();
  }
});

test("a page pulls only its own business's changes", async () => {
  const d = await deployment();
  try {
    await (await d.tenancy.space('hillside.test')).catalog.put('eggs', { name: 'Eggs', cents: 600, left: 5 });
    await (await d.tenancy.space('garrett8.test')).holds.choose('ada', 'show-1930', { units: ['A1'] });
    const farm = await d.ask('hillside.test', '/_zb/sync/pull?since=0');
    const cinema = await d.ask('garrett8.test', '/_zb/sync/pull?since=0');
    assert.equal(farm.status, 200);
    assert.deepEqual(keysOf(farm.json.changes), ['items/eggs']);
    assert.deepEqual(keysOf(cinema.json.changes), ['holds/show-1930/ada', 'units/show-1930/A1']);
  } finally {
    await d.close();
  }
});

test("a page's push lands in its own business only", async () => {
  const d = await deployment();
  try {
    const push = await d.ask('garrett8.test', '/_zb/sync/push', { method: 'POST', body: { changes: [{ collection: 'notes', key: 'n1', field: 'text', value: 'popcorn', clock: clock(1) }] } });
    assert.equal(push.status, 200);
    assert.equal((await d.tenancy.space('garrett8.test')).store.get('notes', 'n1').text, 'popcorn');
    assert.equal((await d.tenancy.space('hillside.test')).store.get('notes', 'n1'), null);
    // The kit's own collections (stock, holds) stay the server's.
    const items = await d.ask('garrett8.test', '/_zb/sync/push', { method: 'POST', body: { changes: [{ collection: 'items', key: 'popcorn', field: 'left', value: 999, clock: clock(2) }] } });
    assert.equal(items.status, 403);
    assert.deepEqual((await d.ask('hillside.test', '/_zb/sync/pull?since=0')).json.changes, []);
  } finally {
    await d.close();
  }
});

test("a live page hears its own business's writes and never another's", async () => {
  const d = await deployment();
  const farmPage = d.listen('hillside.test');
  const cinemaPage = d.listen('garrett8.test');
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await (await d.tenancy.space('garrett8.test')).holds.choose('ada', 'show-1930', { units: ['B7'] });
    await (await d.tenancy.space('hillside.test')).catalog.put('honey', { name: 'Honey', cents: 1200, left: 2 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(cinemaPage.text(), /B7/);
    assert.doesNotMatch(cinemaPage.text(), /Honey/);
    assert.match(farmPage.text(), /Honey/);
    assert.doesNotMatch(farmPage.text(), /B7/);
  } finally {
    farmPage.close();
    cinemaPage.close();
    await d.close();
  }
});

test('a host nobody answers to gets nothing, and opens nothing', async () => {
  const d = await deployment();
  try {
    assert.equal((await d.ask('evil.test', '/_zb/sync/pull?since=0')).status, 404);
    assert.equal((await d.ask('evil.test', '/_zb/sync/push', { method: 'POST', body: { changes: [] } })).status, 404);
    assert.equal((await d.ask('evil.test', '/')).status, 404);
    assert.equal(await d.tenancy.space('evil.test'), null);
    assert.deepEqual(d.opened, []);
  } finally {
    await d.close();
  }
});

test('a business is opened once, even when its first requests arrive together', async () => {
  const d = await deployment();
  try {
    const spaces = await Promise.all(Array.from({ length: 8 }, () => d.tenancy.space('hillside.test')));
    assert.ok(spaces.every((space) => space === spaces[0]));
    await Promise.all(Array.from({ length: 5 }, () => d.ask('hillside.test', '/_zb/sync/pull?since=0')));
    assert.deepEqual(d.opened, ['hillside']);
    assert.deepEqual(d.tenancy.opened(), ['hillside']);
    assert.equal((await d.tenancy.spaceOf('garrett8')).tenant.name, 'Garrett 8 Cinema', 'by id, for jobs');
    assert.equal(await d.tenancy.spaceOf('nope'), null);
  } finally {
    await d.close();
  }
});

test('a business that fails to open is tried again next time', async () => {
  let tries = 0;
  const d = await deployment({
    open: async () => {
      tries += 1;
      if (tries === 1) throw new Error('disk busy');
      return createSyncServer({ log: memoryLog() });
    },
  });
  try {
    await assert.rejects(d.tenancy.space('hillside.test'), /disk busy/);
    assert.equal((await d.tenancy.space('hillside.test')).tenant.id, 'hillside');
    assert.equal(tries, 2);
  } finally {
    await d.close();
  }
});

test('the business comes from the host, never from the request', async () => {
  const d = await deployment();
  try {
    await (await d.tenancy.space('garrett8.test')).catalog.put('ticket', { name: 'Ticket', cents: 1100, left: 100 });
    const tried = await d.ask('hillside.test', '/_zb/sync/pull?since=0&tenant=garrett8&business=garrett8');
    assert.deepEqual(tried.json.changes, []);
  } finally {
    await d.close();
  }
});

test('createTenancy refuses what it can\'t use', () => {
  assert.throws(() => createTenancy({ open: () => {} }), /needs tenants/);
  assert.throws(() => createTenancy({ tenants: createTenants({ tenants: TENANTS }) }), /needs open/);
});

test('open must give back a Sync server', async () => {
  const d = await deployment({ open: async () => ({}) });
  try {
    await assert.rejects(d.tenancy.space('hillside.test'), /must return a Sync server/);
  } finally {
    await d.close();
  }
});

test('fetch: a sync request goes to its own business; anything else is null', async () => {
  const d = await deployment();
  try {
    await (await d.tenancy.space('garrett8.test')).holds.choose('ada', 'show-1930', { units: ['C3'] });
    const cinema = await d.tenancy.fetch(new Request('http://garrett8.test/_zb/sync/pull?since=0'));
    assert.deepEqual(keysOf((await cinema.json()).changes), ['holds/show-1930/ada', 'units/show-1930/C3']);
    const farm = await d.tenancy.fetch(new Request('http://hillside.test/_zb/sync/pull?since=0'));
    assert.deepEqual((await farm.json()).changes, []);
    assert.equal((await d.tenancy.fetch(new Request('http://evil.test/_zb/sync/pull?since=0'))).status, 404);
    assert.equal(await d.tenancy.fetch(new Request('http://garrett8.test/showings')), null);
  } finally {
    await d.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenants, themeCss } from '../index.js';

const list = [
  { id: 'cinema', name: 'Example Cinema', hosts: ['cinema.example', 'tickets.cinema.example'], theme: { '--primary': '#7a1f1f', '--radius': '0.5rem' }, modules: ['hold', 'pay'] },
  { id: 'paddle', name: 'Example Paddle', hosts: ['Paddle.Example'], modules: ['hold'] },
];

test('the host name decides, in any spelling', () => {
  const tenants = createTenants({ tenants: list });
  assert.equal(tenants.for('cinema.example').id, 'cinema');
  assert.equal(tenants.for('WWW.Cinema.Example:8080').id, 'cinema');
  assert.equal(tenants.for('tickets.cinema.example.').id, 'cinema');
  assert.equal(tenants.for('paddle.example').id, 'paddle');
  assert.equal(tenants.for('nobody.example'), null);
  assert.equal(tenants.for(''), null);
});

test('it reads fetch Requests and Node requests', () => {
  const tenants = createTenants({ tenants: list });
  assert.equal(tenants.for(new Request('https://paddle.example/book')).id, 'paddle');
  assert.equal(tenants.for(new Request('http://localhost/x', { headers: { host: 'cinema.example' } })).id, 'cinema');
  assert.equal(tenants.for({ headers: { host: 'cinema.example:3000' } }).id, 'cinema');
});

test('nothing but the host can choose a business', () => {
  const tenants = createTenants({ tenants: list });
  const request = new Request('https://paddle.example/?tenant=cinema', { headers: { cookie: 'tenant=cinema', 'x-tenant': 'cinema' } });
  assert.equal(tenants.for(request).id, 'paddle');
});

test('a fallback answers for unknown hosts, when one is named', () => {
  const tenants = createTenants({ tenants: list, fallback: 'cinema' });
  assert.equal(tenants.for('localhost:3000').id, 'cinema');
  assert.throws(() => createTenants({ tenants: list, fallback: 'nope' }), /fallback/);
});

test('modules are switched on per business', () => {
  const tenants = createTenants({ tenants: list });
  assert.equal(tenants.has(tenants.get('cinema'), 'pay'), true);
  assert.equal(tenants.has(tenants.get('paddle'), 'pay'), false);
  assert.equal(tenants.has(null, 'pay'), false);
  assert.deepEqual(tenants.all().map((tenant) => tenant.id), ['cinema', 'paddle']);
});

test('a bad list is refused when the app starts', () => {
  assert.throws(() => createTenants({ tenants: [] }), /list/);
  assert.throws(() => createTenants({ tenants: [{ id: 'Bad Id' }] }), /lower-case/);
  assert.throws(() => createTenants({ tenants: [{ id: 'a' }, { id: 'a' }] }), /Two tenants/);
  assert.throws(() => createTenants({ tenants: [{ id: 'a', hosts: ['x.example'] }, { id: 'b', hosts: ['www.X.example'] }] }), /both a and b/);
});

test('a theme becomes one CSS rule, and nothing can break out of it', () => {
  assert.equal(themeCss(list[0]), ':root {\n  --primary: #7a1f1f;\n  --radius: 0.5rem;\n}\n');
  assert.equal(themeCss(list[1]), '');
  assert.equal(themeCss({ id: 'x', theme: { '--font': '"Barlow Condensed", sans-serif' } }, '.shop'), '.shop {\n  --font: "Barlow Condensed", sans-serif;\n}\n');
  for (const theme of [
    { '--primary': 'red; } body { display: none' },
    { '--primary': 'red</style><script>' },
    { '--bg': 'url(https://elsewhere.example/x.png)' },
    { color: 'red' },
    { '--primary': '' },
    { '--primary': 12 },
  ]) {
    assert.throws(() => themeCss({ id: 'x', theme }), /not a safe CSS custom property/);
  }
});

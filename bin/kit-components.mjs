#!/usr/bin/env node
// Copy the kit's components into an app's components folder: the stand-in for importing them
// from the package.
//
// Zubra `main` can import `.zb` components from a package (#197, merged after the 5.8.0 build), so
// once a release has it an app does this instead and deletes the copies:
//
//   createZubra({ components, packages: ['@potomac-solutions/kit/components'] })
//   import '@potomac-solutions/kit/components/cart-panel.zb'
//
// Until then a `.zb` file imports components by relative path only, so they have to sit in the
// app's folder.
//
//   kit-components add [names...] --to src/components   copy them (all four with no names)
//   kit-components check --to src/components            which copies differ from this kit's
//
// The Zubra UI parts the components use (action-button, text-field, …) come too, but only where
// the app has none: an app that installed its own with the shadcn CLI keeps them. A copy starts
// with a line naming the kit version it came from.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'components');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const files = readdirSync(source).filter((file) => file.endsWith('.zb'));
const isPart = (name) => readFileSync(join(source, `${name}.zb`), 'utf8').startsWith('<!-- Zubra UI (');
const all = files.map((file) => file.slice(0, -3)).sort();
/** The kit's own components (catalog-grid, cart-panel, …), not the Zubra UI parts it carries. */
export const components = all.filter((name) => !isPart(name));

const mark = (name) => `<!-- From @potomac-solutions/kit ${version} (components/${name}.zb). Delete once Zubra imports components from packages. -->\n`;
const imports = (text) => [...text.matchAll(/import\s+['"]\.\/([a-z0-9-]+)\.zb['"]/g)].map((match) => match[1]);

export function add(names, to) {
  const unknown = names.filter((name) => !components.includes(name));
  if (unknown.length) throw new Error(`No kit component called ${unknown.join(', ')}. There are: ${components.join(', ')}`);
  mkdirSync(to, { recursive: true });
  const wrote = [];
  const kept = [];
  const parts = new Set();
  for (const name of names.length ? names : components) {
    const text = readFileSync(join(source, `${name}.zb`), 'utf8');
    writeFileSync(join(to, `${name}.zb`), mark(name) + text);
    wrote.push(name);
    for (const part of imports(text)) parts.add(part);
  }
  for (const part of [...parts].sort()) {
    if (existsSync(join(to, `${part}.zb`))) kept.push(part);
    else {
      writeFileSync(join(to, `${part}.zb`), mark(part) + readFileSync(join(source, `${part}.zb`), 'utf8'));
      wrote.push(part);
    }
  }
  return { wrote, kept };
}

export function check(to) {
  return all
    .filter((name) => existsSync(join(to, `${name}.zb`)))
    .map((name) => {
      const copy = readFileSync(join(to, `${name}.zb`), 'utf8');
      const first = copy.slice(0, copy.indexOf('\n') + 1);
      const from = /@potomac-solutions\/kit (\S+) /.exec(first)?.[1] ?? null;
      const now = readFileSync(join(source, `${name}.zb`), 'utf8');
      // The app's own (no mark): left alone. Same text as now: current. Else changed or older.
      const state = !from ? 'own' : copy.slice(first.length) === now ? 'current' : from === version ? 'changed' : 'older';
      return { name, from, state };
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const at = rest.indexOf('--to');
  const to = at >= 0 ? resolve(rest[at + 1] ?? '') : null;
  const names = rest.filter((arg, i) => arg !== '--to' && i !== at + 1);
  if (!to || !['add', 'check'].includes(command)) {
    console.log('kit-components add [names...] --to <components folder>\nkit-components check --to <components folder>');
    process.exit(command ? 1 : 0);
  }
  if (command === 'add') {
    const { wrote, kept } = add(names, to);
    console.log(`copied ${wrote.join(', ')} (kit ${version}) to ${to}`);
    if (kept.length) console.log(`kept the app's own ${kept.join(', ')}`);
  } else {
    for (const { name, from, state } of check(to)) console.log(`${state.padEnd(8)} ${name}${from ? ` (from ${from})` : ''}`);
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barChart, rankBars, CHART_CSS } from '../index.js';

test('a bar per point, the tallest at the top line, each with its tip, and a table of the same numbers', () => {
  const svg = barChart([{ label: 'Mon', value: 2 }, { label: 'Tue', value: 4, tip: 'Tuesday: 4' }, { label: 'Wed', value: 0 }], { name: 'Rentals', format: (n) => `${n} out` });
  assert.equal((svg.match(/class="bar"/g) ?? []).length, 2, 'no bar for zero');
  assert.equal((svg.match(/class="hit"/g) ?? []).length, 3, 'every point can be hovered');
  assert.match(svg, /<title>Mon: 2 out<\/title>/);
  assert.match(svg, /<title>Tuesday: 4<\/title>/);
  assert.match(svg, /aria-label="Rentals"/);
  assert.match(svg, /<summary>Rentals as a table<\/summary>[\s\S]*<td>Wed<\/td><td>0 out<\/td>/);
  assert.match(svg, />4 out<\/text>/, 'the top line is labelled with the largest value');
});

test('labels, names and tips are escaped', () => {
  const svg = barChart([{ label: '<b>', value: 1, tip: '"><script>' }], { name: '<img>' });
  assert.ok(!/<b>|<script>|<img>/.test(svg));
  assert.ok(!rankBars([{ label: '<script>', value: 1 }]).includes('<script>'));
});

test('rank bars are sized against the largest, and stay within the track', () => {
  const html = rankBars([{ label: 'Kayaks', value: 50 }, { label: 'Bikes', value: 25 }, { label: 'Odd', value: -5 }], { format: (n) => `$${n}` });
  assert.match(html, /Kayaks[\s\S]*width:100\.0%[\s\S]*\$50/);
  assert.match(html, /Bikes[\s\S]*width:50\.0%/);
  assert.match(html, /Odd[\s\S]*width:0\.0%/);
  assert.match(CHART_CSS, /\.chart \.bar \{ fill: var\(--primary\); \}/);
});

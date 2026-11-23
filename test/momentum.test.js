// Run: node --test test/momentum.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Momentum } = require('../lib/momentum');

const feed = (m, rows) => rows.map(([a, h, period = 2, clock = '6:00']) =>
  m.update({ id: '1', state: 'in', period, clock, away: { abbr: 'NY', score: a }, home: { abbr: 'BOS', score: h } }).map((x) => x.text).join(' | '));

test('a 12-point run alerts once, then again 10 points later', () => {
  const out = feed(new Momentum(), [[70, 70], [70, 73], [70, 77], [72, 80], [72, 84], [72, 87], [72, 90], [74, 93], [74, 97]]);
  assert.deepStrictEqual(out.filter(Boolean), ['BOS on a 14-2 run', 'BOS on a 27-4 run']);
});

test('trading baskets never alerts', () => {
  const rows = []; let a = 50, h = 50;
  for (let i = 0; i < 40; i++) { if (i % 2) a += 2 + (i % 3 === 0); else h += 2; rows.push([a, h]); }
  assert.ok(feed(new Momentum(), rows).every((x) => x === ''));
});

test('lead changes alert only in the last two minutes of the 4th or OT', () => {
  const out = feed(new Momentum(), [[100, 101, 4, '5:00'], [102, 101, 4, '4:30'], [102, 103, 4, '2:10'], [105, 103, 4, '1:55'], [105, 105, 4, '1:20'], [105, 107, 4, '0:48'], [108, 107, 5, '4.2']]);
  assert.deepStrictEqual(out.filter(Boolean), ['NY takes the lead', 'BOS takes the lead', 'NY takes the lead']);
});

const test = require('node:test');
const assert = require('node:assert');
const { NhlOverlay, espnAbbr } = require('../lib/nhl');

const game = (a, h) => ({ BOS: { id: '1', league: 'nhl', state: 'in', away: { abbr: 'BOS', score: a }, home: { abbr: 'TB', score: h } } });
const feed = (a, h) => new Map([['BOS@TB', { away: a, home: h }]]);

test('NHL feed first: score goes up before ESPN has it, once', () => {
  const o = new NhlOverlay();
  let g = game(0, 0);
  assert.deepStrictEqual(o.apply(g, feed(1, 0)).map((x) => x.team), ['BOS']);
  assert.strictEqual(g.BOS.away.score, 1);
  g = game(0, 0); // ESPN still behind on the next poll
  assert.strictEqual(o.apply(g, feed(1, 0)).length, 0);
  assert.strictEqual(g.BOS.away.score, 1);
  g = game(1, 0); // ESPN catches up
  o.apply(g, feed(1, 0));
  assert.strictEqual(g.BOS.away.score, 1);
});

test('ESPN first: nothing changes', () => {
  const o = new NhlOverlay();
  const g = game(1, 0);
  assert.strictEqual(o.apply(g, feed(0, 0)).length, 0);
  assert.strictEqual(g.BOS.away.score, 1);
});

test('a failed or stale NHL read never drops a goal (no double celebration)', () => {
  const o = new NhlOverlay();
  o.apply(game(0, 0), feed(1, 0));
  let g = game(0, 0);
  o.apply(g, null); // NHL read failed
  assert.strictEqual(g.BOS.away.score, 1);
  g = game(0, 0);
  o.apply(g, feed(0, 0)); // one stale read
  assert.strictEqual(g.BOS.away.score, 1);
});

test('goal taken back on review comes off after 3 NHL reads, if ESPN never had it', () => {
  const o = new NhlOverlay();
  o.apply(game(0, 0), feed(1, 0));
  let g;
  for (let i = 0; i < 2; i++) { g = game(0, 0); o.apply(g, feed(0, 0)); assert.strictEqual(g.BOS.away.score, 1); }
  g = game(0, 0); o.apply(g, feed(0, 0));
  assert.strictEqual(g.BOS.away.score, 0);
});

test('only live NHL games, matched on both teams, with ESPN team codes', () => {
  const o = new NhlOverlay();
  const g = game(0, 0); g.BOS.state = 'post';
  assert.strictEqual(o.apply(g, feed(1, 0)).length, 0);
  const nfl = { NE: { id: '2', league: 'nfl', state: 'in', away: { abbr: 'BOS', score: 0 }, home: { abbr: 'TB', score: 0 } } };
  assert.strictEqual(o.apply(nfl, feed(7, 0)).length, 0);
  assert.strictEqual(espnAbbr('TBL'), 'TB');
  assert.strictEqual(espnAbbr('NJD'), 'NJ');
  assert.strictEqual(espnAbbr('BOS'), 'BOS');
});

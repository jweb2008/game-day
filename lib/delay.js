// Holds every feed update for the delay, so the screens (and later the lights)
// show what is on your TV, not what the data feed already knows.

class DelayBuffer {
  constructor(maxSeconds = 180) {
    this.maxMs = maxSeconds * 1000;
    this.items = []; // { t, value }, oldest first
  }

  push(value, t = Date.now()) {
    this.items.push({ t, value });
    const cutoff = t - this.maxMs;
    while (this.items.length > 1 && this.items[1].t <= cutoff) this.items.shift();
  }

  // Newest value that is at least `delayMs` old, or null while still filling up.
  at(delayMs, now = Date.now()) {
    const target = now - delayMs;
    let found = null;
    for (const item of this.items) {
      if (item.t <= target) found = item.value;
      else break;
    }
    return found;
  }
}

// Compares two delayed snapshots of one game and lists what happened in between.
function diffGame(prev, next) {
  if (!prev || !next || prev.id !== next.id) return [];
  const events = [];
  if (prev.state === 'pre' && next.state === 'in') events.push({ type: 'start' });
  for (const side of ['home', 'away']) {
    const before = prev[side];
    const after = next[side];
    if (!before || !after) continue;
    const points = after.score - before.score;
    if (points > 0) events.push({ type: 'score', team: after.abbr, points, score: after.score });
  }
  // A new 3rd down (football): the screens show a banner, louder when your team is on defense.
  const third = (g) => /^3rd/i.test(g.downDistance || '');
  if (next.state === 'in' && third(next) && !third(prev)) {
    const offense = [next.home, next.away].find((t) => t && t.id === next.possession);
    events.push({ type: 'third', offense: offense ? offense.abbr : null, text: next.downDistance });
  }
  if (prev.state !== 'post' && next.state === 'post') {
    const winner = [next.home, next.away].find((t) => t && t.winner);
    events.push({ type: 'final', winner: winner ? winner.abbr : null });
  }
  return events;
}

module.exports = { DelayBuffer, diffGame };

// Basketball alerts that matter: a big scoring run (12-0, 15-3, 26-3) and a lead change in the last
// two minutes of the 4th quarter or overtime. Every other basket just scrolls on the ticker.
// Fed the delayed ticker snapshots, so alerts land with the TV.

const RUN_MIN = 12;    // a run is outscoring the other team by at least this much...
const RUN_RATIO = 3;   // ...while scoring at least 3 times as many points (15-3 yes, 20-8 no)
const RUN_STEP = 10;   // a run that keeps going alerts again every 10 more points of margin
const LATE_SECONDS = 120;

function clockSeconds(clock) {
  const m = /^(\d+):(\d+)(?:\.\d+)?$/.exec(String(clock || '').trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const s = /^(\d+(?:\.\d+)?)$/.exec(String(clock || '').trim());
  return s ? Number(s[1]) : null;
}

class Momentum {
  constructor() { this.games = new Map(); } // id -> { hist: [{a, h}], run: {side, from, margin}, leader }

  // Returns the alerts for this snapshot of one game: [{ kind: 'run'|'lead', team, text }]
  update(t) {
    if (!t || !t.away || !t.home || t.state !== 'in') { if (t && t.state === 'post') this.games.delete(t.id); return []; }
    let g = this.games.get(t.id);
    const a = Number(t.away.score) || 0, h = Number(t.home.score) || 0;
    if (!g) { g = { hist: [{ a, h }], run: null, leader: Math.sign(a - h) }; this.games.set(t.id, g); return []; }
    const last = g.hist[g.hist.length - 1];
    if (a === last.a && h === last.h) return [];
    g.hist.push({ a, h });
    if (g.hist.length > 120) g.hist.shift();
    const out = [];

    // Scoring run: the best stretch ending now for either team.
    let best = null;
    for (const side of ['away', 'home']) {
      const mine = side === 'away' ? 'a' : 'h', theirs = side === 'away' ? 'h' : 'a';
      for (let i = 0; i < g.hist.length - 1; i++) {
        const us = (side === 'away' ? a : h) - g.hist[i][mine], them = (side === 'away' ? h : a) - g.hist[i][theirs];
        if (us - them >= RUN_MIN && us >= RUN_RATIO * them && (!best || us - them > best.margin)) best = { side, us, them, margin: us - them, from: i };
      }
    }
    if (!best) g.run = null;
    else {
      const fresh = !g.run || g.run.side !== best.side;
      if (fresh || best.margin >= g.run.alerted + RUN_STEP) {
        const team = t[best.side].abbr;
        out.push({ kind: 'run', team, text: `${team} on a ${best.us}-${best.them} run` });
        g.run = { side: best.side, alerted: best.margin };
      }
    }

    // Lead change, late: 4th quarter or overtime, two minutes or less.
    const leader = Math.sign(a - h);
    const secs = clockSeconds(t.clock);
    if (leader !== 0 && g.leader !== 0 && leader !== g.leader && Number(t.period) >= 4 && secs != null && secs <= LATE_SECONDS) {
      const team = leader > 0 ? t.away.abbr : t.home.abbr;
      out.push({ kind: 'lead', team, text: `${team} takes the lead` });
    }
    if (leader !== 0) g.leader = leader;
    return out;
  }
}

module.exports = { Momentum, clockSeconds };

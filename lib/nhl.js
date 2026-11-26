// The NHL's own live scores (api-web.nhle.com), read beside ESPN during hockey games.
// The NHL's feed usually shows a goal several seconds before ESPN's does, so for each live
// NHL game the screens take the higher of the two scores, side by side. Everything else
// (clock, scorer, stats, finals) still comes from ESPN.

const NHL_BASE = process.env.NHL_BASE || 'https://api-web.nhle.com';

// NHL team codes ESPN spells differently.
const FIX = { NJD: 'NJ', TBL: 'TB', LAK: 'LA', SJS: 'SJ', UTA: 'UTAH' };
const espnAbbr = (a) => FIX[a] || a;

async function fetchNhlScores() {
  const res = await fetch(`${NHL_BASE}/v1/score/now`, { headers: { 'User-Agent': 'game-day/1.0' }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`NHL feed answered ${res.status}`);
  const body = await res.json();
  const out = new Map(); // "AWY@HOM" in ESPN codes -> { away, home }
  for (const g of body.games || []) {
    if (!/^(LIVE|CRIT)$/.test(g.gameState || '')) continue;
    const a = g.awayTeam || {}, h = g.homeTeam || {};
    if (!a.abbrev || !h.abbrev || a.score == null || h.score == null) continue;
    out.set(`${espnAbbr(a.abbrev)}@${espnAbbr(h.abbrev)}`, { away: Number(a.score), home: Number(h.score) });
  }
  return out;
}

// Raises each live NHL game's score to the NHL feed's where it is ahead of ESPN's.
// A score the NHL feed raised holds until ESPN reaches it, so a slow or failed NHL read never
// drops a goal and then celebrates it twice. It comes off only when the NHL feed has shown the
// lower score DROP_READS reads in a row (a goal taken back on review) and ESPN agrees.
const DROP_READS = 3;
class NhlOverlay {
  constructor() { this.held = new Map(); } // "gameId:side" -> { score, low }
  apply(games, nhl) {
    const ahead = [];
    const seen = new Set();
    for (const g of Object.values(games)) {
      if (g.league !== 'nhl' || g.state !== 'in' || !g.away || !g.home) continue;
      const n = nhl && nhl.get(`${g.away.abbr}@${g.home.abbr}`);
      for (const side of ['away', 'home']) {
        const key = `${g.id}:${side}`;
        seen.add(key);
        const espn = Number(g[side].score);
        const fresh = n && Number.isFinite(n[side]) ? n[side] : null;
        let h = this.held.get(key);
        if (h && espn >= h.score) { this.held.delete(key); h = null; } // ESPN caught up
        if (fresh != null && fresh > espn && (!h || fresh >= h.score)) {
          if (!h || fresh > h.score) ahead.push({ id: g.id, team: g[side].abbr, espn, nhl: fresh });
          h = { score: fresh, low: 0 };
          this.held.set(key, h);
        } else if (h && fresh != null && fresh < h.score) {
          if (++h.low >= DROP_READS) { this.held.delete(key); h = null; } // taken back
        } else if (h && fresh != null) h.low = 0;
        if (h) g[side] = { ...g[side], score: h.score };
      }
    }
    for (const k of this.held.keys()) if (!seen.has(k)) this.held.delete(k);
    return ahead;
  }
}

module.exports = { fetchNhlScores, NhlOverlay, espnAbbr };

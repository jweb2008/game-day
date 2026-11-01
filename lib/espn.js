// Reads ESPN's public scoreboard feed and turns each game into a small, stable shape
// the rest of the app (and the screens) can rely on, whatever ESPN changes around it.

const ESPN_BASE = process.env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports';

async function fetchScoreboard(sport, league) {
  const url = `${ESPN_BASE}/${sport}/${league}/scoreboard`;
  const res = await fetch(url, { headers: { 'User-Agent': 'game-day/1.0' } });
  if (!res.ok) throw new Error(`ESPN ${league} answered ${res.status}`);
  return res.json();
}

function color(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean}` : null;
}

function normalizeTeam(c) {
  const t = c.team || {};
  return {
    id: String(t.id ?? ''),
    abbr: t.abbreviation || '',
    name: t.shortDisplayName || t.name || '',
    fullName: t.displayName || '',
    logo: t.logo || null,
    color: color(t.color),
    altColor: color(t.alternateColor),
    homeAway: c.homeAway || '',
    score: Number.parseInt(c.score, 10) || 0,
    record: (c.records && c.records[0] && c.records[0].summary) || null,
    winner: c.winner === true,
  };
}

function normalizeEvent(ev, league) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const status = ev.status || comp.status || {};
  const type = status.type || {};
  const competitors = (comp.competitors || []).map(normalizeTeam);
  const home = competitors.find((c) => c.homeAway === 'home') || competitors[0] || null;
  const away = competitors.find((c) => c.homeAway === 'away') || competitors[1] || null;
  const sit = comp.situation || {};
  const broadcast = (comp.broadcasts || []).flatMap((b) => b.names || []).join(', ') || null;
  return {
    id: String(ev.id),
    league,
    name: ev.shortName || ev.name || '',
    start: ev.date || null,
    state: type.state || 'pre', // pre | in | post
    detail: type.shortDetail || type.detail || '',
    period: status.period || 0,
    clock: status.displayClock || '',
    home,
    away,
    possession: sit.possession ? String(sit.possession) : null,
    downDistance: sit.downDistanceText || sit.shortDownDistanceText || null,
    redZone: sit.isRedZone === true,
    lastPlay: (sit.lastPlay && sit.lastPlay.text) || null,
    broadcast,
  };
}

// Returns { [teamAbbr]: game } for the teams we follow in this league.
function pickFollowed(scoreboard, league, abbrs) {
  const out = {};
  for (const ev of scoreboard.events || []) {
    const game = normalizeEvent(ev, league);
    for (const abbr of abbrs) {
      if (game.home?.abbr === abbr || game.away?.abbr === abbr) {
        // Prefer a live game over a finished one, and a finished one over a future one.
        const rank = { in: 0, post: 1, pre: 2 };
        const current = out[abbr];
        if (!current || rank[game.state] < rank[current.state]) out[abbr] = game;
      }
    }
  }
  return out;
}

module.exports = { fetchScoreboard, normalizeEvent, pickFollowed };

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
    // Scoreboard gives "7"; team schedules give { value: 7, displayValue: "7" }.
    score: Number.parseInt(c.score && typeof c.score === 'object' ? c.score.value : c.score, 10) || 0,
    record: (c.records && c.records[0] && c.records[0].summary) || null,
    // Points per quarter / period, in order.
    periods: (c.linescores || []).map((l) => Number(l.value ?? l.displayValue) || 0),
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

// A team's season schedule, used when the team has no game on today's scoreboard.
async function fetchTeamSchedule(sport, league, abbr) {
  const url = `${ESPN_BASE}/${sport}/${league}/teams/${abbr.toLowerCase()}/schedule`;
  const res = await fetch(url, { headers: { 'User-Agent': 'game-day/1.0' } });
  if (!res.ok) throw new Error(`ESPN ${league} ${abbr} schedule answered ${res.status}`);
  return res.json();
}

// Next game that hasn't finished (or one still within 4 hours of starting); else the latest result.
function pickFromSchedule(schedule, league, now = Date.now()) {
  const games = (schedule.events || []).map((ev) => normalizeEvent(ev, league)).filter((g) => g.start);
  games.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const upcoming = games.find((g) => g.state !== 'post' && Date.parse(g.start) > now - 4 * 3600 * 1000);
  if (upcoming) return upcoming;
  const done = games.filter((g) => g.state === 'post');
  return done.length ? done[done.length - 1] : null;
}

module.exports = { fetchScoreboard, fetchTeamSchedule, normalizeEvent, pickFollowed, pickFromSchedule };

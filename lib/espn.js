// Reads ESPN's public scoreboard feed and turns each game into a small, stable shape
// the rest of the app (and the screens) can rely on, whatever ESPN changes around it.

const ESPN_BASE = process.env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports';

// opts.dates = 'YYYYMMDD' for one day (default: ESPN's current day or week); opts.groups for college.
async function fetchScoreboard(sport, league, opts = {}) {
  const q = new URLSearchParams();
  if (opts.dates) q.set('dates', opts.dates);
  if (opts.groups) q.set('groups', opts.groups);
  if (opts.dates) q.set('limit', '300');
  const url = `${ESPN_BASE}/${sport}/${league}/scoreboard${q.toString() ? '?' + q : ''}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'game-day/1.0' } });
  if (!res.ok) throw new Error(`ESPN ${league} answered ${res.status}`);
  return res.json();
}

function color(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean}` : null;
}

// Tennis players and fighters have an athlete where teams have a team: make them look like one.
function athleteAsTeam(a, id) {
  const full = a.displayName || a.fullName || '';
  const last = a.lastName || full.split(' ').slice(-1)[0] || '';
  return {
    id: a.id || id, abbreviation: (a.shortName || last).replace(/\s+/g, ' '), shortDisplayName: a.shortName || last,
    displayName: full, logo: (a.flag && a.flag.href) || (a.headshot && a.headshot.href) || null,
  };
}

function normalizeTeam(c, league) {
  const t = c.team || (c.athlete ? athleteAsTeam(c.athlete, c.id) : null)
    || (c.roster && c.roster.athletes && c.roster.athletes[0] ? athleteAsTeam({ ...c.roster.athletes[0], displayName: c.roster.shortDisplayName || c.roster.displayName }, c.id) : {});
  const abbr = t.abbreviation || '';
  // Scoreboards give team.logo; season schedules give team.logos[]. Failing both, ESPN's usual address.
  const logo = t.logo || (t.logos && t.logos[0] && t.logos[0].href)
    || (abbr && league && c.team ? `https://a.espncdn.com/i/teamlogos/${league}/500/${abbr.toLowerCase()}.png` : null);
  return {
    id: String(t.id ?? ''),
    abbr: t.abbreviation || '',
    name: t.shortDisplayName || t.name || '',
    fullName: t.displayName || '',
    logo,
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
  const competitors = (comp.competitors || []).map((c) => normalizeTeam(c, league));
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
    // Where the ball is, for the field view: yards to the end zone the offense is driving at.
    yardsToEndzone: sit.yardsToEndzone ?? null,
    down: sit.down ?? null,
    distance: sit.distance ?? null,
    lastPlay: (sit.lastPlay && sit.lastPlay.text) || null,
    broadcast,
  };
}

// Tennis and UFC: each match or fight in an event (tennis nests them in groupings) as its own game,
// id "<event>-<match>", with the players or fighters as the two sides.
function matchesOf(ev, league) {
  const comps = [
    ...(ev.competitions || []),
    ...(ev.groupings || []).flatMap((gr) => gr.competitions || []),
  ];
  return comps.filter((c) => (c.competitors || []).length === 2).map((c) => {
    const g = normalizeEvent({
      id: `${ev.id}-${c.id}`, name: `${ev.name || ''}`, shortName: ev.shortName,
      date: c.date || c.startDate || ev.date, status: c.status || ev.status, competitions: [c],
    }, league);
    // Tennis has sets, not a score: count sets won.
    const [a, b] = c.competitors;
    if (a.score == null && b.score == null && a.linescores && b.linescores) {
      let sa = 0, sb = 0;
      a.linescores.forEach((ls, i) => {
        const x = Number(ls.value), y = Number((b.linescores[i] || {}).value);
        const done = ls.winner != null || (b.linescores[i] || {}).winner != null || g.state === 'post' || i < a.linescores.length - 1;
        if (done && x > y) sa++; else if (done && y > x) sb++;
      });
      const sideA = [g.home, g.away].find((t) => t && String(t.id) === String((a.athlete && a.athlete.id) || a.id));
      const sideB = [g.home, g.away].find((t) => t && t !== sideA);
      if (sideA) sideA.score = sa;
      if (sideB) sideB.score = sb;
      g.sets = a.linescores.map((ls, i) => `${ls.value}-${(b.linescores[i] || {}).value}`).join(' ');
    }
    g.event = ev.shortName || ev.name || '';
    g.round = (c.round && c.round.displayName) || (c.type && c.type.text) || '';
    g.kind = 'match';
    return g;
  });
}

// Golf and racing: the whole field on a leaderboard. Racing events hold several sessions
// (practice, qualifying, race): show the one running now, else the next, else the last.
function normalizeField(ev, league) {
  const comps = ev.competitions || [];
  const st = (c) => (((c.status || ev.status || {}).type) || {}).state;
  const comp = comps.find((c) => st(c) === 'in') || comps.find((c) => st(c) === 'pre') || comps[comps.length - 1] || {};
  const status = comp.status || ev.status || {};
  const type = status.type || {};
  const session = (comp.type && (comp.type.abbreviation || comp.type.text)) || '';
  const leaders = (comp.competitors || []).map((c, i) => {
    const a = c.athlete || {};
    const score = c.score && typeof c.score === 'object' ? c.score.displayValue : c.score;
    const thru = c.status && (c.status.thru != null ? c.status.thru : null);
    return {
      pos: Number(c.order) || (c.status && c.status.position && Number(c.status.position.id)) || i + 1,
      name: a.displayName || (c.team && c.team.displayName) || '',
      short: a.shortName || a.displayName || '',
      pic: (a.flag && a.flag.href) || (a.headshot && a.headshot.href) || (c.team && c.team.logo) || null,
      score: score != null ? String(score) : '',
      note: c.vehicle && c.vehicle.number ? `#${c.vehicle.number}` : thru != null && thru !== '' ? (Number(thru) >= 18 ? 'F' : `thru ${thru}`) : '',
      winner: c.winner === true,
    };
  }).sort((x, y) => x.pos - y.pos);
  return {
    id: String(ev.id), league, kind: 'field', name: ev.name || ev.shortName || '', shortName: ev.shortName || ev.name || '',
    start: ev.date || comp.date || null, end: ev.endDate || null, state: type.state || 'pre',
    detail: [session && !/^race$/i.test(session) ? session : '', type.shortDetail || type.detail || ''].filter(Boolean).join(' · '),
    broadcast: (comp.broadcasts || ev.broadcasts || []).flatMap((b) => b.names || []).join(', ') || null,
    leaders: leaders.slice(0, 40),
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

// Every team in a league with its colors and logo, to fill in what a season schedule leaves out.
async function fetchTeams(sport, league) {
  const url = `${ESPN_BASE}/${sport}/${league}/teams`;
  const res = await fetch(url, { headers: { 'User-Agent': 'game-day/1.0' } });
  if (!res.ok) throw new Error(`ESPN ${league} teams answered ${res.status}`);
  const data = await res.json();
  const list = (((data.sports || [])[0] || {}).leagues || [])[0]?.teams || [];
  const map = {};
  for (const { team: t } of list) {
    if (!t || !t.abbreviation) continue;
    map[t.abbreviation] = {
      color: color(t.color), altColor: color(t.alternateColor),
      logo: (t.logos && t.logos[0] && t.logos[0].href) || null,
      name: t.shortDisplayName || t.name || '', fullName: t.displayName || '',
    };
  }
  return map;
}

module.exports = { matchesOf, normalizeField, fetchTeams, fetchScoreboard, fetchTeamSchedule, normalizeEvent, pickFollowed, pickFromSchedule };

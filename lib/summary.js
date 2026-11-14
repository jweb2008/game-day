// Everything beyond the score that the screens use from ESPN's game summary:
// recent form and players to watch (pregame), drives (live field view), and player headshots.
// ESPN changes these shapes now and then, so every reader here fails soft: missing data means
// that panel simply doesn't show.

const arr = (x) => (Array.isArray(x) ? x : []);
const abbrOf = (t) => (t && (t.abbreviation || t.abbrev)) || '';
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function headshotOf(a, sportPath) {
  if (!a) return null;
  if (a.headshot && typeof a.headshot === 'object' && a.headshot.href) return a.headshot.href;
  if (typeof a.headshot === 'string') return a.headshot;
  return a.id && sportPath ? `https://a.espncdn.com/i/headshots/${sportPath}/players/full/${a.id}.png` : null;
}

// Last five results per team: { KC: [{ result: 'W', us: 24, them: 17, atVs: 'vs', opp: 'LV', oppLogo }] }
function pickForm(summary) {
  const out = {};
  for (const block of arr(summary.lastFiveGames)) {
    const team = block.team || {};
    const abbr = abbrOf(team);
    if (!abbr) continue;
    out[abbr] = arr(block.events).slice(0, 5).map((e) => {
      const opp = e.opponent || {};
      let us = null, them = null;
      if (e.homeTeamScore != null && e.awayTeamScore != null && (e.homeTeamId != null || e.awayTeamId != null)) {
        const home = String(e.homeTeamId) === String(team.id);
        us = Number(home ? e.homeTeamScore : e.awayTeamScore);
        them = Number(home ? e.awayTeamScore : e.homeTeamScore);
      } else {
        const m = /(\d+)\s*-\s*(\d+)/.exec(e.score || '');
        if (m) {
          const [a, b] = [Number(m[1]), Number(m[2])];
          [us, them] = e.gameResult === 'L' ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)];
        }
      }
      return {
        result: e.gameResult || (us != null && them != null ? (us > them ? 'W' : us < them ? 'L' : 'T') : ''),
        us, them, atVs: e.atVs || '', date: e.gameDate || null,
        opp: abbrOf(opp) || '', oppLogo: e.opponentLogo || opp.logo || null,
      };
    });
  }
  return out;
}

// Season leaders per team: { KC: [{ label: 'Passing Yards', name, short, pos, value, headshot }] }
function pickLeaders(summary, sportPath) {
  const out = {};
  for (const block of arr(summary.leaders)) {
    const abbr = abbrOf(block.team);
    if (!abbr) continue;
    out[abbr] = arr(block.leaders).slice(0, 3).map((cat) => {
      const top = arr(cat.leaders)[0];
      if (!top) return null;
      const a = top.athlete || {};
      return {
        id: a.id ? String(a.id) : null, stat: cat.name || '',
        label: cat.displayName || cat.shortDisplayName || cat.name || '',
        name: a.displayName || a.fullName || '', short: a.shortName || a.displayName || '',
        pos: (a.position && a.position.abbreviation) || '', jersey: a.jersey || '',
        value: top.displayValue || String(top.value ?? ''), headshot: headshotOf(a, sportPath),
      };
    }).filter(Boolean);
  }
  return out;
}

// Everyone who has shown up in the game, keyed by a squashed name, so "P.Mahomes" in a play's
// text finds Patrick Mahomes' headshot.
function pickPeople(summary, sportPath) {
  const people = {};
  const add = (a) => {
    if (!a || !(a.displayName || a.shortName)) return;
    const p = { name: a.displayName || a.shortName, short: a.shortName || a.displayName, headshot: headshotOf(a, sportPath), pos: (a.position && a.position.abbreviation) || '' };
    if (a.shortName) people[nameKey(a.shortName)] = p;              // "P. Mahomes" -> pmahomes
    if (a.displayName) {
      people[nameKey(a.displayName)] = p;
      const parts = a.displayName.split(' ');
      if (parts.length > 1) people[nameKey(parts[0][0] + parts.slice(1).join(''))] = p; // pmahomes
    }
  };
  for (const team of arr(summary.boxscore && summary.boxscore.players)) {
    for (const group of arr(team.statistics)) for (const row of arr(group.athletes)) add(row.athlete);
  }
  for (const block of arr(summary.leaders)) for (const cat of arr(block.leaders)) for (const l of arr(cat.leaders)) add(l.athlete);
  return people;
}

// Players named in a play's text, with headshots where we have them (at most three).
function playersIn(text, people) {
  const found = [];
  const re = /\b([A-Z][a-z]?\.\s?[A-Z][A-Za-z'\-]+(?:\s[A-Z][a-z]+)?)/g;
  let m;
  while ((m = re.exec(text || '')) && found.length < 3) {
    const p = people[nameKey(m[1])];
    if (p && !found.some((f) => f.name === p.name)) found.push(p);
  }
  return found;
}

// Drives (football): the current one and the last scoring one, each play with where it started and
// ended as yards to the end zone (0 = touchdown), which is all the field view needs.
function pickDrives(summary, people) {
  const d = summary.drives || {};
  const shape = (drive) => {
    if (!drive) return null;
    const team = abbrOf(drive.team);
    const plays = arr(drive.plays).map((p) => {
      const s = p.start || {}, e = p.end || {};
      return {
        text: p.text || '', type: (p.type && (p.type.text || p.type.abbreviation)) || '',
        from: s.yardsToEndzone ?? null, to: e.yardsToEndzone ?? null,
        yards: p.statYardage ?? null, down: s.down || null, distance: s.distance ?? null,
        downText: s.shortDownDistanceText || s.downDistanceText || '', scoring: !!p.scoringPlay,
        clock: (p.clock && p.clock.displayValue) || '', period: (p.period && p.period.number) || null,
        players: playersIn(p.text, people),
      };
    });
    return {
      id: String(drive.id || ''), team, description: drive.description || '',
      result: drive.displayResult || drive.result || '', isScore: !!drive.isScore,
      start: (drive.start && drive.start.text) || '', plays,
    };
  };
  const previous = arr(d.previous);
  const lastScore = [...previous].reverse().find((x) => x.isScore);
  return { current: shape(d.current), last: shape(previous[previous.length - 1]), lastScore: shape(lastScore) };
}

// Matchup (pregame): ESPN's win chance, records (overall, home, road), streak and scoring averages
// from the standings, the season series (head to head) and the betting line. Anything ESPN leaves
// out is simply missing: { teams: { KC: { winPct, total, home, road, streak, stats: [{label, value}] } }, series, line }
function pickMatchup(summary) {
  const comp = ((summary.header || {}).competitions || [])[0] || {};
  const comps = arr(comp.competitors);
  const byId = {}, teams = {};
  for (const c of comps) {
    const t = c.team || {};
    const abbr = abbrOf(t);
    if (!abbr) continue;
    byId[String(t.id)] = abbr;
    const recs = arr(c.record).concat(arr(c.records));
    const rec = (type) => (recs.find((r) => (r.type || r.name || '').toLowerCase() === type) || {}).summary || (recs.find((r) => (r.type || r.name || '').toLowerCase() === type) || {}).displayValue || null;
    teams[abbr] = {
      home: c.homeAway === 'home', name: t.displayName || t.name || abbr, location: t.location || '',
      total: rec('total') || (recs[0] && (recs[0].summary || recs[0].displayValue)) || null,
      homeRec: rec('home'), roadRec: rec('road') || rec('away'), stats: [],
    };
  }
  // ESPN's win projection.
  const pred = summary.predictor || {};
  for (const side of ['homeTeam', 'awayTeam']) {
    const p = pred[side];
    const abbr = p && (byId[String(p.id)] || (side === 'homeTeam' ? Object.keys(teams).find((k) => teams[k].home) : Object.keys(teams).find((k) => !teams[k].home)));
    const v = p && parseFloat(p.gameProjection ?? p.teamChanceTie ?? '');
    if (abbr && teams[abbr] && Number.isFinite(v)) teams[abbr].winPct = v;
  }
  // Standings rows for these two teams: streak and scoring.
  const WANT = [
    ['streak', 'Streak'], ['avgPointsFor', 'Scored per game'], ['avgPointsAgainst', 'Allowed per game'],
    ['pointsFor', 'Points for'], ['pointsAgainst', 'Points against'], ['differential', 'Differential'],
    ['pointDifferential', 'Differential'], ['goalsFor', 'Goals for'], ['goalsAgainst', 'Goals against'],
  ];
  const groups = arr(summary.standings && summary.standings.groups);
  for (const gr of groups) {
    for (const e of arr((gr.standings || {}).entries)) {
      const tname = typeof e.team === 'string' ? e.team : (e.team && (e.team.displayName || e.team.abbreviation)) || '';
      const abbr = (e.team && e.team.abbreviation && teams[e.team.abbreviation] && e.team.abbreviation)
        || Object.keys(teams).find((k) => teams[k].name === tname || tname.endsWith(teams[k].name.split(' ').slice(-1)[0]) && tname.startsWith(teams[k].location || '~'));
      if (!abbr || teams[abbr].stats.length) continue;
      const stats = arr(e.stats);
      const val = (n) => { const st = stats.find((x) => x.name === n || x.type === n || x.abbreviation === n); return st ? (st.displayValue ?? st.summary ?? String(st.value ?? '')) : null; };
      const seen = new Set();
      for (const [n, label] of WANT) {
        const v = val(n);
        if (v == null || v === '' || seen.has(label)) continue;
        seen.add(label);
        if (label === 'Streak') teams[abbr].streak = v; else teams[abbr].stats.push({ label, value: v });
      }
      teams[abbr].stats = teams[abbr].stats.slice(0, 3);
    }
  }
  // Season series (head to head).
  const ss = arr(summary.seasonseries)[0];
  const series = ss ? (ss.summary || ss.description || ss.title || null) : null;
  // Betting line.
  const pc = arr(summary.pickcenter)[0] || arr(summary.odds)[0];
  const line = pc ? [pc.details, pc.overUnder != null ? `O/U ${pc.overUnder}` : null].filter(Boolean).join(' · ') || null : null;
  return { teams, series, line };
}

// A player's last five games for one stat, from ESPN's game log:
// [{ date, opp, atVs, result, value }] oldest first. The game log lists stat names once (names[])
// and each game's numbers in the same order.
function pickLastFive(gamelog, stat) {
  const names = arr(gamelog.names).map((n) => String(n));
  let i = names.indexOf(stat);
  if (i < 0) i = names.findIndex((n) => n.toLowerCase() === String(stat).toLowerCase());
  if (i < 0) return null;
  const meta = gamelog.events || {};
  const rows = [];
  for (const st of arr(gamelog.seasonTypes)) {
    for (const cat of arr(st.categories)) {
      for (const e of arr(cat.events)) {
        const id = String(e.eventId || e.id || '');
        if (!id || rows.some((r) => r.id === id)) continue;
        const m = meta[id] || {};
        const v = parseFloat(String(arr(e.stats)[i] ?? '').replace(/,/g, ''));
        if (!Number.isFinite(v)) continue;
        rows.push({ id, date: m.gameDate || null, opp: abbrOf(m.opponent), atVs: m.atVs || '', result: m.gameResult || '', value: v });
      }
    }
  }
  rows.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
  return rows.slice(0, 5).reverse();
}

module.exports = { pickLastFive, pickMatchup, pickForm, pickLeaders, pickPeople, pickDrives, playersIn };

// Player box score (hockey and others): per team, skaters with goals, assists, points, shots and
// plus/minus, and goalies with saves. ESPN gives each group's column labels once; values follow in
// the same order. { BOS: { skaters: [{ name, short, jersey, pos, G, A, PTS, SOG, PM, TOI }], goalies: [...] } }
function pickBox(summary, sportPath) {
  const out = {};
  const SK = { G: 'G', A: 'A', PTS: 'PTS', P: 'PTS', SOG: 'SOG', S: 'SOG', '+/-': 'PM', TOI: 'TOI' };
  const GL = { SA: 'SA', SV: 'SV', GA: 'GA', 'SV%': 'SVP', TOI: 'TOI' };
  for (const team of arr(summary.boxscore && summary.boxscore.players)) {
    const abbr = abbrOf(team.team);
    if (!abbr) continue;
    const box = { skaters: [], goalies: [] };
    for (const group of arr(team.statistics)) {
      const labels = arr(group.labels).map(String);
      const goalie = /goal/i.test(group.name || group.text || '') || labels.includes('SV') || labels.includes('SV%');
      const map = goalie ? GL : SK;
      for (const row of arr(group.athletes)) {
        const a = row.athlete || {};
        const p = { name: a.displayName || '', short: a.shortName || a.displayName || '', jersey: a.jersey || '', pos: (a.position && a.position.abbreviation) || '', headshot: headshotOf(a, sportPath) };
        labels.forEach((l, i) => { if (map[l] && p[map[l]] == null) p[map[l]] = arr(row.stats)[i]; });
        (goalie ? box.goalies : box.skaters).push(p);
      }
    }
    const n = (v) => parseFloat(v) || 0;
    box.skaters.sort((x, y) => n(y.PTS) - n(x.PTS) || n(y.G) - n(x.G) || n(y.SOG) - n(x.SOG));
    box.goalies = box.goalies.filter((g) => n(g.SA) > 0 || n(g.SV) > 0 || g.TOI);
    if (box.skaters.length || box.goalies.length) out[abbr] = box;
  }
  return out;
}

// League standings, flattened: one row per team with its conference and division, record, points,
// win percentage and playoff seed. ESPN nests conferences > divisions; we walk whatever it gives.
function pickStandings(data) {
  const rows = [];
  const walk = (node, path) => {
    for (const e of arr(node.standings && node.standings.entries)) {
      const t = e.team || {};
      const stats = arr(e.stats);
      const st = (n) => stats.find((x) => x.name === n || x.type === n || x.abbreviation === n);
      const num = (n) => { const x = st(n); return x ? parseFloat(x.value ?? x.displayValue) : null; };
      const total = stats.find((x) => x.type === 'total' || x.name === 'overall');
      const parts = [num('wins'), num('losses'), num('otLosses') ?? num('overtimeLosses') ?? num('ties')].filter((v) => v != null && Number.isFinite(v));
      rows.push({
        abbr: t.abbreviation || '', name: t.shortDisplayName || t.displayName || '', logo: (arr(t.logos)[0] || {}).href || t.logo || null,
        conf: path[0] || null, div: path[1] || null,
        record: (total && (total.summary || total.displayValue)) || (parts.length >= 2 ? parts.map((v) => Math.round(v)).join('-') : ''),
        points: num('points'), pct: num('winPercent') ?? num('winPct'), gp: num('gamesPlayed'), wins: num('wins'),
        seed: num('playoffSeed'), clinch: (st('clincher') || {}).displayValue || '',
      });
    }
    for (const c of arr(node.children)) walk(c, [...path, c.name || c.abbreviation || '']);
  };
  walk(data, []);
  return rows.filter((r) => r.abbr);
}

module.exports.pickBox = pickBox;
module.exports.pickStandings = pickStandings;

// Stars of the game. Hockey: worked out from the box score (a goal 3, an assist 2, a shot 0.1;
// goalies 0.1 a save, plus 3 for a shutout and 1 for the win), since ESPN's feed doesn't carry the
// official three stars. Football: the game's top passer, rusher and receiver from ESPN's game leaders.
function pickStars(summary, game, box) {
  const n = (v) => parseFloat(String(v ?? '').replace(/,/g, '')) || 0;
  const winner = [game.home, game.away].find((t) => t && t.winner);
  if (/hockey|nhl/.test(game.league) && box && Object.keys(box).length) {
    const all = [];
    for (const [abbr, b] of Object.entries(box)) {
      for (const p of b.skaters || []) {
        const score = n(p.G) * 3 + n(p.A) * 2 + n(p.SOG) * 0.1;
        if (score > 0) all.push({ ...p, team: abbr, score, line: [n(p.G) && `${n(p.G)} G`, n(p.A) && `${n(p.A)} A`, n(p.SOG) && `${n(p.SOG)} SOG`].filter(Boolean).join(' · ') });
      }
      for (const p of b.goalies || []) {
        const score = n(p.SV) * 0.1 + (n(p.GA) === 0 && n(p.SV) > 0 ? 3 : 0) + (winner && winner.abbr === abbr ? 1 : 0);
        all.push({ ...p, team: abbr, score, line: `${n(p.SV)} saves${p.SVP ? ` · ${p.SVP} SV%` : ''}${n(p.GA) === 0 && n(p.SV) > 0 ? ' · shutout' : ''}` });
      }
    }
    return all.sort((a, b) => b.score - a.score).slice(0, 3).map(({ name, short, headshot, team, line, pos, jersey }) => ({ name, short, headshot, team, line, pos, jersey }));
  }
  // Football (and others with game leaders): the best line in each of the first three categories.
  const best = {};
  for (const block of arr(summary.leaders)) {
    const abbr = abbrOf(block.team);
    for (const cat of arr(block.leaders).slice(0, 3)) {
      const top = arr(cat.leaders)[0];
      if (!top) continue;
      const m = /([\d,]+)\s*YDS/i.exec(top.displayValue || '');
      const v = m ? n(m[1]) : n(top.value);
      const key = cat.name || cat.displayName;
      if (!best[key] || v > best[key].v) {
        const a = top.athlete || {};
        best[key] = { v, name: a.displayName || '', short: a.shortName || a.displayName || '', headshot: headshotOf(a, game.league === 'nfl' ? 'nfl' : null), team: abbr, pos: (a.position && a.position.abbreviation) || '', line: top.displayValue || '', label: cat.displayName || '' };
      }
    }
  }
  return Object.values(best).map(({ v, ...p }) => p).slice(0, 3);
}

module.exports.pickStars = pickStars;

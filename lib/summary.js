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

module.exports = { pickForm, pickLeaders, pickPeople, pickDrives, playersIn };

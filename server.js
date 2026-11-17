// Game Day: reads the games you follow, holds them for your TV delay,
// and streams them to the screens in the lounge.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchRoster, matchesOf, normalizeField, fetchTeams, fetchScoreboard, fetchTeamSchedule, normalizeEvent, pickFollowed, pickFromSchedule } = require('./lib/espn');
const { DelayBuffer, diffGame } = require('./lib/delay');
const { fetchSummary, fetchGamelog, fetchStandings, pickStats } = require('./lib/stats');
const { pickStars, pickBox, pickStandings, pickLastFive, pickMatchup, pickForm, pickLeaders, pickPeople, pickDrives } = require('./lib/summary');
const { LEAGUES, SPORTS, league: leagueInfo } = require('./lib/leagues');

// The sport for a league key: your teams' leagues first, then the calendar's catalog.
function sportOf(lg) {
  return (config.teams.find((t) => t.league === lg) || leagueInfo(lg) || {}).sport;
}

const ROOT = __dirname;
const LOCAL_CONFIG = path.join(ROOT, 'config.local.json'); // per-house settings, never in git

function loadConfig() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (fs.existsSync(LOCAL_CONFIG)) {
    try {
      Object.assign(base, JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8')));
    } catch (err) {
      console.error('config.local.json is not valid JSON, ignoring it:', err.message);
    }
  }
  return base;
}

function saveLocal(patch) {
  let local = {};
  if (fs.existsSync(LOCAL_CONFIG)) {
    try { local = JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8')); } catch { local = {}; }
  }
  Object.assign(local, patch);
  fs.writeFileSync(LOCAL_CONFIG, JSON.stringify(local, null, 2));
}

const config = loadConfig();
const port = Number(process.env.PORT || config.port || 80);

// ---- feed -------------------------------------------------------------

const buffer = new DelayBuffer(180);
let live = { at: null, games: {} }; // newest feed data, not delayed
let lastFeedError = null;

function leagues() {
  const map = new Map();
  for (const t of config.teams) {
    const key = `${t.sport}/${t.league}`;
    if (!map.has(key)) map.set(key, { sport: t.sport, league: t.league, abbrs: [] });
    map.get(key).abbrs.push(t.abbr);
  }
  return [...map.values()];
}

const scheduleCache = new Map(); // abbr -> { t, game }

// League team lists (colors, logos), refreshed once a day, to fill gaps in schedule data.
const teamDirs = new Map(); // league -> { t, map }
async function teamDirectory(lg) {
  const cached = teamDirs.get(lg.league);
  if (cached && Date.now() - cached.t < 24 * 3600 * 1000) return cached.map;
  try {
    const map = await fetchTeams(lg.sport, lg.league);
    teamDirs.set(lg.league, { t: Date.now(), map });
    return map;
  } catch (err) {
    console.error('teams error:', err.message);
    if (cached) return cached.map;
    teamDirs.set(lg.league, { t: Date.now() - 23 * 3600 * 1000, map: {} }); // try again in an hour
    return {};
  }
}

function fillTeam(t, dir) {
  const d = t && dir[t.abbr];
  if (!d) return;
  t.color = t.color || d.color;
  t.altColor = t.altColor || d.altColor;
  t.name = t.name || d.name;
  t.fullName = t.fullName || d.fullName;
  if (d.logo && (!t.logo || /\/500\/[a-z]+\.png$/.test(t.logo))) t.logo = d.logo;
}

// A team's next games after a given one, with each opponent's record (from the standings when we
// have them). Schedules are kept 6 hours.
const fullSchedCache = new Map(); // league:abbr -> { t, games }
async function upcomingFor(lg, abbr, after, count, standingRows) {
  const key = `${lg.league}:${abbr}`;
  let c = fullSchedCache.get(key);
  if (!c || Date.now() - c.t > 6 * 3600 * 1000) {
    try {
      const sched = await fetchTeamSchedule(lg.sport, lg.league, abbr);
      c = { t: Date.now(), games: (sched.events || []).map((ev) => normalizeEvent(ev, lg.league)).filter((g) => g.start && g.home && g.away) };
    } catch (err) {
      console.error('schedule error:', err.message);
      c = { t: Date.now() - 5 * 3600 * 1000, games: c ? c.games : [] };
    }
    fullSchedCache.set(key, c);
  }
  const from = Date.parse(after.start || 0);
  const rec = (a) => ((standingRows || []).find((r) => r.abbr === a) || {}).record || null;
  return c.games
    .filter((g) => g.id !== after.id && Date.parse(g.start) > from && g.state !== 'post')
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, count)
    .map((g) => {
      const home = g.home.abbr === abbr;
      const opp = home ? g.away : g.home;
      return { start: g.start, home, broadcast: g.broadcast, opp: { abbr: opp.abbr, name: opp.name, logo: opp.logo, record: rec(opp.abbr) || opp.record || null } };
    });
}

async function nextFromSchedule(lg, abbr) {
  const cached = scheduleCache.get(abbr);
  if (cached && Date.now() - cached.t < 15 * 60 * 1000) return cached.game;
  try {
    const game = pickFromSchedule(await fetchTeamSchedule(lg.sport, lg.league, abbr), lg.league);
    if (game) { const dir = await teamDirectory(lg); fillTeam(game.home, dir); fillTeam(game.away, dir); }
    scheduleCache.set(abbr, { t: Date.now(), game });
    return game;
  } catch (err) {
    console.error('schedule error:', err.message);
    return cached ? cached.game : null;
  }
}

// Every game in the leagues we follow, for the scrolling ticker.
function tickerItems(sb, league) {
  return (sb.events || []).map((ev) => {
    const g = normalizeEvent(ev, league);
    return {
      id: g.id, league, state: g.state, detail: g.detail, start: g.start,
      away: g.away ? { abbr: g.away.abbr, score: g.away.score } : null,
      home: g.home ? { abbr: g.home.abbr, score: g.home.score } : null,
    };
  }).filter((t) => t.away && t.home);
}

async function pollOnce() {
  const games = {};
  const ticker = [];
  for (const lg of leagues()) {
    try {
      const sb = await fetchScoreboard(lg.sport, lg.league);
      Object.assign(games, pickFollowed(sb, lg.league, lg.abbrs));
      ticker.push(...tickerItems(sb, lg.league));
      // Teams with no game today: show their next game from the season schedule.
      for (const abbr of lg.abbrs) {
        if (games[abbr]) continue;
        const next = await nextFromSchedule(lg, abbr);
        if (next) games[abbr] = next;
      }
      lastFeedError = null;
    } catch (err) {
      lastFeedError = `${new Date().toISOString()} ${err.message}`;
      console.error('feed error:', err.message);
      // Keep showing the last good data for this league rather than blanking the screen.
      for (const abbr of lg.abbrs) if (live.games[abbr]) games[abbr] = live.games[abbr];
      ticker.push(...(live.ticker || []).filter((t) => t.league === lg.league));
    }
  }
  // Games picked on the calendar come first, so on game day they win the screens.
  const watched = await pollWatched();
  const all = { ...watched, ...games };
  // A picked game that one of your teams is playing in: the calendar pick wins, so it isn't shown or celebrated twice.
  const watchedIds = new Set(Object.values(watched).map((g) => g.id));
  for (const [k, g] of Object.entries(games)) if (watchedIds.has(g.id)) delete all[k];
  await addStats(all);
  noteScores(live.games, all);
  noteFinals(live.games, all);
  live = { at: new Date().toISOString(), games: all, ticker };
  buffer.push(live);
}

// When each game went final, so the screens can hold the postgame (stats, stars, what's next)
// before moving on. A game already final when the app started counts as ending 3 hours after its start.
const finalAt = new Map();
function noteFinals(before, after) {
  const prev = new Map(Object.values(before || {}).map((g) => [g.id, g]));
  for (const g of Object.values(after)) {
    if (g.state !== 'post' || finalAt.has(g.id)) continue;
    const old = prev.get(g.id);
    finalAt.set(g.id, old && old.state !== 'post' ? Date.now() : Math.min(Date.now(), Date.parse(g.start || 0) + 3 * 3600 * 1000));
  }
  if (finalAt.size > 200) finalAt.delete(finalAt.keys().next().value);
}

// What update.sh last did (written by the script, newest first).
function readUpdateLog() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'update-log.json'), 'utf8')).slice(0, 5); } catch { return []; }
}

// ---- Sync to a score ---------------------------------------------------------
// When each score first showed up in ESPN's feed (before the delay). Tapping "Sync" the moment
// a score happens on your TV sets the delay to how long ago the app saw it, so the screens and
// lights land with the TV. The score is the anchor; the clock is not (ESPN's clock lags in chunks).
const scoreLog = []; // newest first: { id, key, team, score, at }
function noteScores(before, after) {
  const prev = new Map(Object.values(before || {}).map((g) => [g.id, g]));
  for (const [key, g] of Object.entries(after)) {
    const old = prev.get(g.id);
    if (!old || g.state !== 'in') continue;
    for (const side of ['home', 'away']) {
      if (g[side] && old[side] && Number(g[side].score) > Number(old[side].score)) {
        if (scoreLog.some((x) => x.id === g.id && x.team === g[side].abbr && x.score === g[side].score)) continue;
        scoreLog.unshift({ id: g.id, key, league: g.league, team: g[side].abbr, score: g[side].score, at: Date.now() });
      }
    }
  }
  scoreLog.length = Math.min(scoreLog.length, 30);
}

// The score to sync to: the newest one in the game on the screens, else the newest anywhere,
// as long as it's within the delay buffer.
function syncTarget(gameId) {
  const fresh = scoreLog.filter((x) => Date.now() - x.at <= 175 * 1000);
  if (gameId) return fresh.find((x) => x.id === gameId || x.key === gameId) || null;
  const pick = slotPick(shown ? followedGames(shown.games) : {});
  const mainId = pick && shown && shown.games[pick.mode === 'break' ? pick.main : pick.key]?.id;
  const feat = featured() && live.games[featured()]?.id;
  return fresh.find((x) => x.id === mainId) || fresh.find((x) => x.id === feat) || fresh[0] || null;
}

function setDelay(seconds) {
  config.delaySeconds = seconds;
  saveLocal({ delaySeconds: seconds });
  broadcast('state', screenState());
}

// ---- the watch list (games picked on the calendar) ---------------------
// Each one: { id, league, date: 'YYYYMMDD', start, cheer: 'home'|'away'|'both'|'none', away, home, label }.
// Its game joins the screens from 3 hours before the start until 90 minutes after the final,
// under the key G<id> so it never mixes with your own teams.

const finalSeen = new Map(); // id -> when the final was first seen

// Every game on a scoreboard, in the shape its kind of league needs.
function gamesFromBoard(sb, lgKey) {
  const kind = (leagueInfo(lgKey) || {}).kind || 'team';
  const events = sb.events || [];
  if (kind === 'field') return events.map((ev) => normalizeField(ev, lgKey));
  if (kind === 'match') return events.flatMap((ev) => matchesOf(ev, lgKey));
  return events.map((ev) => normalizeEvent(ev, lgKey)).filter((g) => g.home && g.away);
}

// When a pick is over: its end (golf and racing run for days), else 12 hours after the start.
const watchEnd = (w) => (w.end ? Date.parse(w.end) + 12 * 3600 * 1000 : Date.parse(w.start) + 12 * 3600 * 1000);

function watchList() {
  // Drop picks that ended more than two days ago.
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  const list = (config.watch || []).filter((w) => watchEnd(w) > cutoff);
  if (list.length !== (config.watch || []).length) { config.watch = list; saveLocal({ watch: list }); }
  return list;
}

async function pollWatched() {
  const now = Date.now();
  const out = {};
  const boards = new Map();
  for (const w of watchList()) {
    const start = Date.parse(w.start);
    if (now < start - 3 * 3600 * 1000 || now > watchEnd(w)) continue;
    const lg = leagueInfo(w.league);
    if (!lg) continue;
    // Golf and racing run for days: read today's board for them, not the day they were picked.
    const dates = lg.kind === 'field' ? null : w.date;
    const key = `${w.league}:${dates || 'now'}`;
    if (!boards.has(key)) {
      try { boards.set(key, gamesFromBoard(await fetchScoreboard(lg.sport, w.league, { dates, groups: lg.groups }), w.league)); }
      catch (err) { console.error('watch feed error:', err.message); boards.set(key, null); }
    }
    const found = (boards.get(key) || []).find((g) => String(g.id) === String(w.id));
    const game = found || live.games[`G${w.id}`];
    if (!game) continue;
    if (game.state === 'post') {
      if (!finalSeen.has(w.id)) finalSeen.set(w.id, now);
      if (now - finalSeen.get(w.id) > 90 * 60 * 1000) continue;
    }
    game.watch = { cheer: w.cheer };
    out[`G${w.id}`] = game;
  }
  return out;
}

// Calendar: every game in a league on one day.
const calendarCache = new Map(); // league:date -> { t, games }

async function calendarDay(lgKey, date) {
  const lg = leagueInfo(lgKey);
  if (!lg) throw new Error('unknown league');
  const key = `${lgKey}:${date}`;
  const cached = calendarCache.get(key);
  if (cached && Date.now() - cached.t < 60 * 1000) return cached.games;
  const games = gamesFromBoard(await fetchScoreboard(lg.sport, lgKey, { dates: date, groups: lg.groups }), lgKey);
  calendarCache.set(key, { t: Date.now(), games });
  return games;
}

const brief = (t) => (t ? { abbr: t.abbr, name: t.name, fullName: t.fullName, logo: t.logo, color: t.color, record: t.record } : null);

// From ESPN's game summary: box score stats (live), recent form and players to watch (pregame),
// drives and headshots (live football). Live games refresh every 10s, pregame within 36 hours every
// 10 minutes, a final once.
const summaryCache = new Map(); // eventId -> { t, state, extra, raw }
const HEADSHOT_PATH = { nfl: 'nfl', nhl: 'nhl', nba: 'nba', mlb: 'mlb', wnba: 'wnba', 'college-football': 'college-football', 'mens-college-basketball': 'mens-college-basketball' };

function summaryDue(game, cached) {
  if (!cached) return true;
  if (cached.state === 'post' && game.state === 'post') return false;
  const age = Date.now() - cached.t;
  if (game.state === 'in') return age > 10000;
  if (game.state === 'post') return true; // the final, once
  return age > 10 * 60 * 1000;
}

function readSummary(summary, game) {
  const sportPath = HEADSHOT_PATH[game.league] || null;
  const people = pickPeople(summary, sportPath);
  const box = pickBox(summary, sportPath);
  return {
    stars: game.state === 'post' ? pickStars(summary, game, box) : null,
    stats: pickStats(summary, game.league, game.away?.id, game.home?.id),
    form: pickForm(summary),
    leaders: pickLeaders(summary, sportPath),
    matchup: pickMatchup(summary),
    box: pickBox(summary, sportPath),
    drives: /football|nfl|cfl|ufl/.test(game.league) ? pickDrives(summary, people) : null,
  };
}

// Standings for pregame screens, per league, refreshed every 30 minutes.
const standingsCache = new Map(); // league -> { t, rows }
async function standingsFor(lg) {
  const c = standingsCache.get(lg);
  if (c && Date.now() - c.t < 30 * 60 * 1000) return c.rows;
  try {
    const rows = pickStandings(await fetchStandings(sportOf(lg), lg));
    standingsCache.set(lg, { t: Date.now(), rows });
    return rows;
  } catch (err) {
    console.error('standings error:', err.message);
    standingsCache.set(lg, { t: Date.now() - 25 * 60 * 1000, rows: c ? c.rows : null }); // retry in 5 minutes
    return c ? c.rows : null;
  }
}

// Spotlight (pregame): each team's top player in its first leader category (goals, passing yards...),
// game by game over their last five. Game logs change once a game, so they're kept for 6 hours.
const gamelogCache = new Map(); // athleteId -> { t, data }
// Spotlights, last five games each. Hockey: a forward (the team's top scorer), the defenseman with
// the most points lately, and the goalie who has been starting. Other sports: the top leader.
const rosterCache = new Map(); // "league:abbr" -> { t, list }
async function gamelogOf(game, id) {
  let c = gamelogCache.get(id);
  if (!c || Date.now() - c.t > 6 * 3600 * 1000) {
    try { c = { t: Date.now(), data: await fetchGamelog(sportOf(game.league), game.league, id) }; }
    catch (err) { console.error('game log error:', err.message); c = { t: Date.now() - 5 * 3600 * 1000, data: null }; } // retry in an hour
    gamelogCache.set(id, c);
  }
  return c.data;
}
async function rosterOf(game, abbr) {
  const key = `${game.league}:${abbr}`;
  let c = rosterCache.get(key);
  if (!c || Date.now() - c.t > 12 * 3600 * 1000) {
    try { c = { t: Date.now(), list: await fetchRoster(sportOf(game.league), game.league, abbr) }; }
    catch (err) { console.error('roster error:', err.message); c = { t: Date.now() - 11 * 3600 * 1000, list: [] }; }
    rosterCache.set(key, c);
  }
  return c.list;
}
const lastFive = (data, ...stats) => { for (const st of stats) { const g = data && pickLastFive(data, st); if (g && g.length) return { stat: st, games: g }; } return null; };
const recent = (games, days = 21) => games.filter((x) => x.date && Date.now() - Date.parse(x.date) < days * 86400 * 1000).length;
const sum = (games) => games.reduce((a, x) => a + x.value, 0);

async function spotlight(game, leaders) {
  const hockey = /hockey|nhl/.test(game.league);
  const out = {};
  for (const [abbr, list] of Object.entries(leaders || {})) {
    const cards = [];
    // Forward (or, outside hockey, the team's first leader).
    const top = (list || []).find((p) => p.id && p.stat && (!hockey || !/^(D|G)$/.test(p.pos))) || (list || [])[0];
    if (top && top.id && top.stat) {
      const data = await gamelogOf(game, top.id);
      const games = data ? pickLastFive(data, top.stat) : null;
      if (games && games.length) cards.push({ role: hockey ? 'Forward' : '', name: top.name, short: top.short, pos: top.pos, headshot: top.headshot, label: top.label, games });
    }
    if (hockey) {
      const roster = await rosterOf(game, abbr);
      const isD = (p) => /^D$/i.test(p.pos) || /defen/i.test(p.group) || /defen/i.test(p.pos);
      const isG = (p) => /^G$/i.test(p.pos) || /goal/i.test(p.group) || /goal/i.test(p.pos);
      const logs = async (people, ...stats) => (await Promise.all(people.map(async (p) => {
        const f = lastFive(await gamelogOf(game, p.id), ...stats);
        return f ? { p, ...f } : null;
      }))).filter((x) => x && recent(x.games) > 0);
      // Defenseman: most points over his last five.
      const ds = await logs(roster.filter(isD), 'points', 'PTS');
      ds.sort((a, b) => sum(b.games) - sum(a.games) || recent(b.games) - recent(a.games));
      if (ds[0]) cards.push({ role: 'Defense', name: ds[0].p.name, short: ds[0].p.short, pos: 'D', headshot: ds[0].p.headshot, label: 'Points', games: ds[0].games });
      // Goalie: the one with the most starts lately, by save percentage (saves if that's missing).
      const gs = await logs(roster.filter(isG), 'savePct', 'SV%', 'saves', 'SV');
      gs.sort((a, b) => recent(b.games, 14) - recent(a.games, 14) || Date.parse(b.games[b.games.length - 1].date || 0) - Date.parse(a.games[a.games.length - 1].date || 0));
      if (gs[0]) {
        const pct = /pct|%/i.test(gs[0].stat);
        cards.push({ role: 'Goalie', name: gs[0].p.name, short: gs[0].p.short, pos: 'G', headshot: gs[0].p.headshot, label: pct ? 'Save %' : 'Saves', avg: pct, games: gs[0].games });
      }
    }
    if (cards.length) out[abbr] = cards;
  }
  return out;
}

async function addStats(games) {
  const seen = new Set();
  for (const game of Object.values(games)) {
    if (game.kind === 'field' || game.kind === 'match') continue; // no box score to show
    const soon = game.state !== 'pre' || (game.start && Date.parse(game.start) - Date.now() < 36 * 3600 * 1000);
    if (!soon) continue;
    if (!seen.has(game.id)) {
      seen.add(game.id);
      const cached = summaryCache.get(game.id);
      if (summaryDue(game, cached)) {
        try {
          const raw = await fetchSummary(sportOf(game.league), game.league, game.id);
          summaryCache.set(game.id, { t: Date.now(), state: game.state, extra: readSummary(raw, game), raw });
        } catch (err) {
          console.error('summary error:', err.message);
          // Don't hammer ESPN while it's failing (the feed is checked every 2 seconds in a game).
          if (cached) cached.t = Date.now();
          else summaryCache.set(game.id, { t: Date.now(), state: game.state, extra: null, raw: null });
        }
      }
    }
    const extra = summaryCache.get(game.id)?.extra;
    if (!extra) continue;
    game.stats = game.state === 'pre' ? [] : extra.stats;
    if (game.state === 'pre') {
      game.form = extra.form; game.leaders = extra.leaders; game.matchup = extra.matchup;
      game.spotlight = await spotlight(game, extra.leaders);
      game.standings = await standingsFor(game.league);
    }
    if (game.state !== 'pre' && extra.box && Object.keys(extra.box).length) game.box = extra.box;
    // Upcoming games: the next five for each team before this game, the very next one after it.
    if (game.state === 'pre' || game.state === 'post') {
      const rows = game.state === 'post' ? await standingsFor(game.league) : game.standings;
      const lg = { sport: sportOf(game.league), league: game.league };
      game.upcoming = {};
      for (const t of [game.away, game.home]) {
        if (t && t.abbr) game.upcoming[t.abbr] = await upcomingFor(lg, t.abbr, game, game.state === 'pre' ? 5 : 1, rows);
      }
    }
    if (game.state === 'post' && extra.stars && extra.stars.length) game.stars = extra.stars;
    if (game.state === 'in' && extra.drives) game.drives = extra.drives;
    if (game.state === 'post' && extra.drives) game.drives = { lastScore: extra.drives.lastScore };
  }
  // Forget games that have dropped off the board.
  const current = new Set(Object.values(games).map((g) => g.id));
  for (const id of summaryCache.keys()) if (!current.has(id)) summaryCache.delete(id);
}

function busy() {
  const soon = Date.now() + 30 * 60 * 1000;
  return Object.values(live.games).some(
    (g) => g.state === 'in' || (g.state === 'pre' && g.start && Date.parse(g.start) < soon)
  );
}

async function pollLoop() {
  // One bad poll (odd data from ESPN) must never take the server, and the screens, down with it.
  try { await pollOnce(); } catch (err) { lastFeedError = `${new Date().toISOString()} ${err.message}`; console.error('poll failed:', err.stack || err.message); }
  const wait = busy() ? config.pollSeconds : config.idlePollSeconds;
  setTimeout(pollLoop, Math.max(2, wait) * 1000);
}

// ---- delayed view + events -------------------------------------------

let shown = null; // the delayed snapshot the screens are showing
const recentEvents = [];
const recentTD = new Map(); // "gameId:abbr" -> time of their last touchdown, to tell a 2-point try from a safety

// What kind of score it was, so the screens know which takeover to run.
function scoreKind(ev, game) {
  const scoring = game.league === 'nhl' ? 'goals' : game.league === 'nfl' ? 'football' : (leagueInfo(game.league) || {}).scoring;
  if (scoring === 'goals') return 'goal';
  if (scoring !== 'football') return 'point'; // basketball and baseball: no score takeover
  const key = `${game.id}:${ev.team}`;
  if (ev.points >= 6) { recentTD.set(key, Date.now()); return 'touchdown'; }
  if (ev.points === 3) return 'fieldgoal';
  if (ev.points === 2) return Date.now() - (recentTD.get(key) || 0) < 5 * 60 * 1000 ? 'twopoint' : 'safety';
  return 'extrapoint';
}

function publish(event) {
  recentEvents.unshift(event);
  recentEvents.length = Math.min(recentEvents.length, 50);
  console.log('event:', JSON.stringify(event));
  broadcast('game', event);
  if (event.type !== 'anthem' && event.type !== 'clear') sendToHA(event);
}

// ---- Home Assistant ------------------------------------------------------
// Each event goes to a Home Assistant webhook the moment the screens show it (already on the delay),
// so the lights fire off the same data at the same time as the takeovers.
const haLink = { lastOk: null, lastError: null };

async function sendToHA(event) {
  const ha = config.homeAssistant;
  if (!ha || !ha.url || !ha.webhook) return;
  const url = `${ha.url.replace(/\/$/, '')}/api/webhook/${encodeURIComponent(ha.webhook)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    haLink.lastOk = new Date().toISOString();
    haLink.lastError = null;
  } catch (err) {
    haLink.lastError = `${new Date().toISOString()} ${err.message}`;
    console.error('home assistant:', err.message);
  }
}
const clients = new Set();

function send(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(type, data) {
  for (const res of clients) send(res, type, data);
}

// Follow switches (set from Home Assistant): a team switched off is left off the screens and
// sends no events. Teams never mentioned are followed.
const following = (abbr) => abbr.startsWith('G') || !config.follow || config.follow[abbr] !== false;
// Game picker: which followed team the screens feature; null means automatic.
const featured = () => (config.featured && following(config.featured) ? config.featured : null);

function followedGames(games) {
  return Object.fromEntries(Object.entries(games || {}).filter(([abbr]) => following(abbr)));
}

// ---- Game slots -----------------------------------------------------------
// Fifteen slots in priority order, each holding one of your teams (its current or next game) or a
// calendar pick (G<id>). Live slots take turns on the screens every few minutes; with none live
// the highest slot with a game coming up shows, then the highest with a final. Empty slots: the
// screens choose on their own, as before.
const SLOT_COUNT = 15;
const slots = () => {
  const list = Array.isArray(config.slots) ? config.slots.slice(0, SLOT_COUNT) : [];
  while (list.length < SLOT_COUNT) list.push(null);
  return list;
};
const slotCycleMs = () => Math.max(1, Number(config.slotCycleMinutes) || 5) * 60 * 1000;

// A game at a stoppage long enough to look elsewhere: halftime, an intermission, the end of a period.
function onBreak(g) {
  return /STATUS_HALFTIME|STATUS_END_PERIOD|INTERMISSION/i.test(g.statusName || '') || /halftime|intermission|^end\b|end of/i.test(g.detail || '');
}

const POST_HOLD_MS = 90 * 60 * 1000;
const NEXT_GAP_MS = 15 * 60 * 1000;
function slotPick(games) {
  // "Show now" from the dashboard holds one game until it's cleared.
  if (config.pin && games[config.pin]) return { key: config.pin, pinned: true, live: 0 };
  const filled = slots().filter((k) => k && games[k]);
  if (!filled.length) return null;
  const live = filled.filter((k) => games[k].state === 'in');
  if (live.length) {
    // The main game (highest live slot) stays up. Only while it's on a break do the other live
    // games take turns, every few minutes; when play resumes the screens go straight back.
    const main = live[0];
    if (!onBreak(games[main])) return { key: main, live: live.length, turn: 0, mode: 'main' };
    const others = live.slice(1).filter((k) => !onBreak(games[k]));
    if (!others.length) return { key: main, live: live.length, turn: 0, mode: 'main' };
    const turn = Math.floor(Date.now() / slotCycleMs()) % others.length;
    return { key: others[turn], live: live.length, turn: live.indexOf(others[turn]), mode: 'break', main };
  }
  // Nothing live. A game that just ended keeps the screens (postgame stats, stars, and a teaser for
  // the next game) as long as the next game is at least 15 minutes away, for up to 90 minutes.
  // Back to back (next one under 15 minutes out): straight to the next game.
  const next = filled.filter((k) => games[k].state === 'pre').sort((a, b) => Date.parse(games[a].start || 0) - Date.parse(games[b].start || 0))[0] || null;
  const lead = next ? Date.parse(games[next].start || 0) - Date.now() : Infinity;
  const ended = (k) => finalAt.get(games[k].id) || Date.parse(games[k].start || 0) + 3 * 3600 * 1000;
  const recent = filled.filter((k) => games[k].state === 'post' && Date.now() - ended(k) < POST_HOLD_MS).sort((a, b) => ended(b) - ended(a))[0];
  if (recent && lead >= NEXT_GAP_MS) return { key: recent, live: 0, mode: 'post', upNext: next };
  const final = filled.find((k) => games[k].state === 'post');
  return { key: next || final || filled[0], live: 0 };
}

// Your followed teams always have a slot, so their games show up without a daily calendar pick.
// A team slot holds that team's current or next game, so it never needs updating. Empty a team's
// slot on the dashboard and it stays out until you add it back.
function ensureFavorites() {
  const list = slots();
  const removed = new Set(config.slotsRemoved || []);
  let changed = false;
  for (const t of config.teams) {
    if (!following(t.abbr) || removed.has(t.abbr) || list.includes(t.abbr)) continue;
    const free = list.indexOf(null);
    if (free < 0) break;
    list[free] = t.abbr; changed = true;
  }
  if (changed) saveSlots(list);
}

function saveSlots(list) {
  config.slots = list.slice(0, SLOT_COUNT).map((k) => k || null);
  saveLocal({ slots: config.slots });
  broadcast('state', screenState());
}

function screenState() {
  const games = shown ? followedGames(shown.games) : {};
  return {
    delaySeconds: config.delaySeconds,
    timeZone: config.timeZone || null,
    buffering: shown === null,
    at: shown ? shown.at : null,
    games,
    featured: featured(),
    slot: slotPick(games),
    ticker: shown ? shown.ticker || [] : [],
  };
}

// The newest snapshot events were worked out from. It only moves forward, so making the
// delay longer (the screens step back in time) never replays a score a second time.
let eventBase = null;

// Who the room cheers for in a game: your team, or the side(s) you picked on the calendar.
function cheerTeams(key, game) {
  if (!key.startsWith('G')) return [key];
  const c = (game.watch || {}).cheer;
  return [(c === 'away' || c === 'both') && game.away?.abbr, (c === 'home' || c === 'both') && game.home?.abbr].filter(Boolean);
}

// Team colors as [r, g, b] for the lights; a near-black first color gives way to the second.
function rgb(hex) {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : null;
}
function teamColors(t) {
  if (!t) return {};
  let c1 = rgb(t.color), c2 = rgb(t.altColor);
  if (c1 && c1[0] + c1[1] + c1[2] < 60 && c2) [c1, c2] = [c2, c1];
  // A bulb can't show black: it would just switch off. Dark seconds become white.
  if (!c2 || (c1 && c2.join() === c1.join()) || c2[0] + c2[1] + c2[2] < 60) c2 = [255, 255, 255];
  return { color_1: c1 || [255, 255, 255], color_2: c2 };
}

function tick() {
  try { tickInner(); } catch (err) { console.error('tick failed:', err.stack || err.message); }
}

function tickInner() {
  const next = buffer.at(config.delaySeconds * 1000);
  if (!next || next === shown) return;
  const forward = !eventBase || Date.parse(next.at) > Date.parse(eventBase.at);
  if (eventBase && forward) {
    for (const [abbr, game] of Object.entries(next.games)) {
      if (!following(abbr)) continue;
      for (const ev of diffGame(eventBase.games[abbr], game)) {
        const event = { ...ev, follow: abbr, game: game.id, league: game.league, at: new Date().toISOString() };
        if (ev.type === 'score') event.kind = scoreKind(ev, game);
        const cheer = cheerTeams(abbr, game);
        const who = ev.type === 'score' ? ev.team : ev.type === 'final' ? ev.winner : ev.type === 'third' ? ev.offense : cheer[0];
        event.cheerTeams = cheer;
        event.cheer = !!who && cheer.includes(who);
        Object.assign(event, teamColors([game.home, game.away].find((t) => t && t.abbr === (event.cheer ? who : cheer[0])) || game.home));
        if (abbr.startsWith('G')) event.label = game.name;
        publish(event);
      }
    }
  }
  // Score alerts for the ticker: any other game whose score went up since the last snapshot.
  if (eventBase && forward) {
    const before = new Map((eventBase.ticker || []).map((t) => [t.id, t]));
    for (const t of next.ticker || []) {
      const b = before.get(t.id);
      if (!b || !b.away || !b.home || !t.away || !t.home) continue;
      const da = t.away.score - b.away.score, dh = t.home.score - b.home.score;
      if (da > 0 || dh > 0) broadcast('alert', { id: t.id, league: t.league, detail: t.detail, away: t.away, home: t.home, scorer: da > 0 ? t.away.abbr : t.home.abbr });
    }
  }
  if (forward) eventBase = next;
  shown = next;
  broadcast('state', screenState());
}

// ---- sounds and videos -------------------------------------------------
// Files are named for the moment they play on, optionally for one team:
// touchdown.mp4, KC-touchdown.mp3, BOS-win.mp3 (Dirty Water), anthem.mp3 ...
// BOS-logo.webp replaces ESPN's logo for that team on every screen.
// They live outside the code folder, so updates never touch them.

const MEDIA_DIR = path.resolve(ROOT, config.mediaDir || 'media');
const MOMENTS = ['touchdown', 'fieldgoal', 'safety', 'twopoint', 'goal', 'win', 'defense', 'anthem', 'logo'];
const AUDIO = ['mp3', 'm4a', 'wav', 'ogg'];
const VIDEO = ['mp4', 'webm'];
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const MAX_UPLOAD = 150 * 1024 * 1024;

// Names: [league_][TEAM-]moment.ext, e.g. nhl_BOS-logo.webp, nhl_BOS-win.mp3, touchdown.mp4.
// The league keeps the Bruins' files off the Celtics (both are BOS).
function mediaName(name) {
  const m = /^(?:([a-z0-9.\-]+)_)?(?:([A-Z]{2,4})-)?([a-z]+)\.([a-z0-9]+)$/.exec(name || '');
  if (!m || !MOMENTS.includes(m[3]) || ![...AUDIO, ...VIDEO, ...IMAGE].includes(m[4])) return null;
  const type = VIDEO.includes(m[4]) ? 'video' : IMAGE.includes(m[4]) ? 'image' : 'audio';
  return { league: m[1] || null, team: m[2] || null, moment: m[3], ext: m[4], type, video: type === 'video' };
}

// Files saved before leagues were part of the name (BOS-logo.webp): give each the league of the
// team you follow with that abbreviation, once, at start-up.
function migrateMedia() {
  if (!fs.existsSync(MEDIA_DIR)) return;
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    const info = mediaName(f);
    if (!info || !info.team || info.league) continue;
    const owners = config.teams.filter((t) => t.abbr === info.team);
    if (owners.length !== 1) continue;
    const to = `${owners[0].league}_${f}`;
    if (!fs.existsSync(path.join(MEDIA_DIR, to))) fs.renameSync(path.join(MEDIA_DIR, f), path.join(MEDIA_DIR, to));
    console.log(`media: ${f} is now ${to}`);
  }
}

function listMedia() {
  if (!fs.existsSync(MEDIA_DIR)) return [];
  return fs.readdirSync(MEDIA_DIR)
    .filter((f) => mediaName(f))
    .map((f) => { const st = fs.statSync(path.join(MEDIA_DIR, f)); return { name: f, size: st.size, v: Math.round(st.mtimeMs), ...mediaName(f) }; });
}

function saveMedia(req, res, name) {
  const info = mediaName(name);
  if (!info) return json(res, 400, { error: `Name must look like touchdown.mp3 or KC-touchdown.mp4 (moments: ${MOMENTS.join(', ')})` });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const tmp = path.join(MEDIA_DIR, `.upload-${Date.now()}`);
  const out = fs.createWriteStream(tmp);
  let bytes = 0;
  let failed = false;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD && !failed) {
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      json(res, 413, { error: 'File is over 150 MB' });
      req.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    // One sound, one video and one picture per moment: replace the old one of the same kind.
    for (const f of listMedia()) {
      if (f.team === info.team && f.league === info.league && f.moment === info.moment && f.type === info.type) fs.rmSync(path.join(MEDIA_DIR, f.name), { force: true });
    }
    fs.renameSync(tmp, path.join(MEDIA_DIR, name));
    broadcast('media', listMedia());
    json(res, 200, { saved: name, bytes });
  });
  out.on('error', (err) => { if (!failed) json(res, 500, { error: err.message }); });
}

// Streams a file, with byte ranges so TV browsers can play video smoothly.
function serveMedia(req, res, name) {
  if (!mediaName(name)) return json(res, 404, { error: 'not found' });
  const file = path.join(MEDIA_DIR, name);
  fs.stat(file, (err, st) => {
    if (err) return json(res, 404, { error: 'not found' });
    const type = TYPES['.' + mediaName(name).ext] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

// ---- takeovers on demand ----------------------------------------------
// For testing from the status page, and for Home Assistant (anthem on and off).

const POINTS = { touchdown: 6, fieldgoal: 3, safety: 2, twopoint: 2, goal: 1 };

function takeover(type, team) {
  const at = new Date().toISOString();
  const follow = (team || config.teams[0].abbr).toUpperCase();
  const game = shown && shown.games[follow];
  const us = game && [game.home, game.away].find((t) => t && t.abbr === follow);
  const base = { follow, game: game ? game.id : null, league: game ? game.league : null, at, test: true, cheerTeams: [follow], cheer: true, ...teamColors(us) };
  if (POINTS[type]) return { ...base, type: 'score', kind: type, team: follow, points: POINTS[type] };
  if (type === 'win') return { ...base, type: 'final', winner: follow };
  if (type === 'third' || type === 'defense') {
    const other = game && [game.home, game.away].find((t) => t && t.abbr !== follow);
    return { ...base, type: 'third', offense: type === 'third' ? follow : (other ? other.abbr : 'OPP'), text: '3rd & 4' };
  }
  if (type === 'anthem') return { type: 'anthem', at };
  if (type === 'clear') return { type: 'clear', at };
  return null;
}

// ---- web --------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, urlPath) {
  const publicDir = path.join(ROOT, 'public');
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    // no-cache: browsers check for a newer page every load, so updates show up without a hard refresh.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    send(res, 'state', screenState());
    send(res, 'media', listMedia());
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/state') return json(res, 200, screenState());

  // For troubleshooting: the raw ESPN summary behind a game, e.g. /api/debug/summary?game=401772938
  if (url.pathname === '/api/debug/summary') {
    const c = summaryCache.get(String(url.searchParams.get('game') || ''));
    if (!c) return json(res, 404, { error: 'no summary for that game yet', games: [...summaryCache.keys()] });
    return json(res, 200, url.searchParams.get('raw') ? c.raw : { at: new Date(c.t).toISOString(), state: c.state, read: c.extra, topKeys: Object.keys(c.raw || {}) });
  }

  // For the nightly update: true while a game you follow (or picked) is on or starts within 90 minutes.
  if (url.pathname === '/api/busy') {
    const soon = Date.now() + 90 * 60 * 1000;
    const games = Object.values(live.games || {});
    const busyNow = games.some((g) => g.state === 'in' || (g.state === 'pre' && g.start && Date.parse(g.start) < soon));
    return json(res, 200, { busy: busyNow });
  }

  if (url.pathname === '/api/status') {
    return json(res, 200, {
      delaySeconds: config.delaySeconds,
      teams: config.teams.map((t) => ({ ...t, following: following(t.abbr) })),
      featured: featured(),
      liveAt: live.at,
      shownAt: shown ? shown.at : null,
      live: live.games,
      feedError: lastFeedError,
      screens: clients.size,
      homeAssistant: { url: config.homeAssistant?.url || null, ...haLink },
      events: recentEvents,
      updates: readUpdateLog(),
    });
  }

  if (url.pathname === '/api/delay' && req.method === 'POST') {
    const seconds = Number(url.searchParams.get('seconds'));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) return json(res, 400, { error: 'seconds must be 0 to 120' });
    setDelay(seconds);
    return json(res, 200, { delaySeconds: seconds });
  }

  // Tap the moment a score happens on your TV. ?game=<id> picks the game; otherwise the one on the screens.
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const hit = syncTarget(url.searchParams.get('game'));
    if (!hit) return json(res, 404, { error: 'No score in the last 3 minutes to sync to. Tap right after a score shows on your TV.' });
    const seconds = Math.min(120, Math.max(0, Math.round((Date.now() - hit.at) / 1000)));
    setDelay(seconds);
    // Home Assistant's Goal delay slider follows, which also saves it for the stream you picked.
    sendToHA({ type: 'delay', seconds, team: hit.team, league: hit.league });
    console.log(`sync: ${hit.team} ${hit.score} seen ${seconds}s ago, delay is now ${seconds}s`);
    return json(res, 200, { delaySeconds: seconds, team: hit.team, score: hit.score });
  }
  if (url.pathname === '/api/sync') return json(res, 200, { scores: scoreLog.filter((x) => Date.now() - x.at <= 175 * 1000).map((x) => ({ ...x, ago: Math.round((Date.now() - x.at) / 1000) })) });

  if (url.pathname === '/api/leagues') return json(res, 200, { sports: SPORTS.map(([key, name]) => ({ key, name })), leagues: LEAGUES.map(({ key, name, sport, kind }) => ({ key, name, sport, kind })) });

  if (url.pathname === '/api/calendar') {
    const lg = url.searchParams.get('league');
    const date = String(url.searchParams.get('date') || '').replace(/-/g, '');
    if (!leagueInfo(lg) || !/^\d{8}$/.test(date)) return json(res, 400, { error: 'need league and date=YYYYMMDD' });
    calendarDay(lg, date).then((games) => {
      const watching = new Map(watchList().map((w) => [String(w.id), w.cheer]));
      json(res, 200, games.map((g) => (g.kind === 'field' ? {
        id: g.id, league: lg, kind: 'field', name: g.name, start: g.start, end: g.end, state: g.state, detail: g.detail, broadcast: g.broadcast,
        leaders: g.state === 'pre' ? [] : g.leaders.slice(0, 3), watch: watching.get(g.id) || null,
      } : {
        id: g.id, league: lg, kind: g.kind || 'team', name: g.name, event: g.event, round: g.round, start: g.start, state: g.state,
        detail: g.sets ? `${g.detail} · ${g.sets}` : g.detail, broadcast: g.broadcast,
        away: { ...brief(g.away), score: g.away.score }, home: { ...brief(g.home), score: g.home.score }, watch: watching.get(g.id) || null,
      })));
    }).catch((err) => json(res, 502, { error: err.message }));
    return;
  }

  if (url.pathname === '/api/watch' && req.method === 'GET') return json(res, 200, watchList());

  if (url.pathname === '/api/watch' && req.method === 'POST') {
    const lg = url.searchParams.get('league');
    const date = String(url.searchParams.get('date') || '').replace(/-/g, '');
    const id = String(url.searchParams.get('id') || '');
    const cheer = String(url.searchParams.get('cheer') || 'none');
    if (!['home', 'away', 'both', 'none'].includes(cheer)) return json(res, 400, { error: 'cheer must be home, away, both or none' });
    if (!leagueInfo(lg) || !/^\d{8}$/.test(date) || !id) return json(res, 400, { error: 'need league, date and id' });
    calendarDay(lg, date).then((games) => {
      const g = games.find((x) => x.id === id);
      if (!g) return json(res, 404, { error: 'game not found on that day' });
      const entry = g.kind === 'field'
        ? { id, league: lg, date, kind: 'field', start: g.start, end: g.end, cheer: 'none', label: g.name }
        : { id, league: lg, date, kind: g.kind || 'team', start: g.start, cheer, label: g.event ? `${g.event}: ${g.away.fullName || g.away.name} vs ${g.home.fullName || g.home.name}` : g.name, away: brief(g.away), home: brief(g.home) };
      config.watch = [...watchList().filter((w) => String(w.id) !== id), entry].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      // A new pick goes into the first empty slot, if there is one.
      const list = slots();
      if (!list.includes(`G${id}`)) { const free = list.indexOf(null); if (free >= 0) { list[free] = `G${id}`; saveSlots(list); } }
      saveLocal({ watch: config.watch });
      json(res, 200, config.watch);
    }).catch((err) => json(res, 502, { error: err.message }));
    return;
  }

  if (url.pathname === '/api/watch' && req.method === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    config.watch = watchList().filter((w) => String(w.id) !== id);
    if (slots().includes(`G${id}`)) saveSlots(slots().map((k) => (k === `G${id}` ? null : k)));
    saveLocal({ watch: config.watch });
    return json(res, 200, config.watch);
  }

  // Game slots: what's in each, what can go in one, and which is on the screens now.
  if (url.pathname === '/api/slots' && req.method === 'GET') {
    const games = live.games || {};
    const watch = watchList();
    const describe = (key) => {
      if (!key) return null;
      const g = games[key];
      const team = config.teams.find((t) => t.abbr === key);
      const w = key.startsWith('G') ? watch.find((x) => `G${x.id}` === key) : null;
      const label = team ? `${team.name} (your team)` : w ? `${(leagueInfo(w.league) || {}).name || w.league} · calendar pick` : key;
      if (g) {
        return { key, label, state: g.state, start: g.start, detail: g.detail, kind: g.kind || 'team', name: g.name,
          away: g.away ? { ...brief(g.away), score: g.away.score } : null, home: g.home ? { ...brief(g.home), score: g.home.score } : null,
          following: following(key) };
      }
      if (w) return { key, label, state: 'pre', start: w.start, detail: '', kind: w.kind || 'team', name: w.label, away: w.away, home: w.home, following: true };
      return { key, label, state: 'none', detail: team ? 'No game found' : 'Ended', following: following(key) };
    };
    const list = slots();
    const candidates = [...config.teams.map((t) => t.abbr), ...watch.map((w) => `G${w.id}`)].filter((k) => !list.includes(k)).map(describe);
    return json(res, 200, {
      slots: list.map(describe), candidates, cycleMinutes: Math.max(1, Number(config.slotCycleMinutes) || 5),
      showing: (slotPick(shown ? followedGames(shown.games) : {}) || {}).key || null, featured: featured(),
      pin: config.pin && (live.games || {})[config.pin] ? config.pin : null,
      pinned: config.pin ? describe(config.pin) : null,
      breakMode: (slotPick(shown ? followedGames(shown.games) : {}) || {}).mode === 'break',
    });
  }

  if (url.pathname === '/api/slots' && req.method === 'POST') {
    if (url.searchParams.has('cycle')) {
      const m = Number(url.searchParams.get('cycle'));
      if (!(m >= 1 && m <= 60)) return json(res, 400, { error: 'cycle must be 1 to 60 minutes' });
      config.slotCycleMinutes = m;
      saveLocal({ slotCycleMinutes: m });
      broadcast('state', screenState());
    }
    if (url.searchParams.has('pin')) {
      const k = String(url.searchParams.get('pin') || '');
      config.pin = k && (live.games || {})[k] ? k : null;
      saveLocal({ pin: config.pin });
      broadcast('state', screenState());
    }
    if (url.searchParams.has('set')) {
      const valid = new Set([...config.teams.map((t) => t.abbr), ...watchList().map((w) => `G${w.id}`)]);
      const list = String(url.searchParams.get('set')).split(',').map((k) => (valid.has(k) ? k : null));
      const before = slots();
      const after = list.map((k, i) => (k && list.indexOf(k) === i ? k : null)).concat(Array(SLOT_COUNT).fill(null)).slice(0, SLOT_COUNT);
      const removed = new Set(config.slotsRemoved || []);
      for (const t of config.teams) {
        if (before.includes(t.abbr) && !after.includes(t.abbr)) removed.add(t.abbr);
        if (after.includes(t.abbr)) removed.delete(t.abbr);
      }
      config.slotsRemoved = [...removed];
      saveLocal({ slotsRemoved: config.slotsRemoved });
      saveSlots(after);
    }
    return json(res, 200, { slots: slots(), cycleMinutes: Math.max(1, Number(config.slotCycleMinutes) || 5) });
  }

  if (url.pathname === '/api/follow' && req.method === 'POST') {
    const team = String(url.searchParams.get('team') || '').toUpperCase();
    if (!config.teams.some((t) => t.abbr === team)) return json(res, 400, { error: `team must be one of ${config.teams.map((t) => t.abbr).join(', ')}` });
    const on = !/^(0|off|false)$/i.test(url.searchParams.get('on') || '1');
    config.follow = { ...(config.follow || {}), [team]: on };
    saveLocal({ follow: config.follow });
    if (on) ensureFavorites();
    broadcast('state', screenState());
    return json(res, 200, { follow: config.follow });
  }

  if (url.pathname === '/api/featured' && req.method === 'POST') {
    const team = String(url.searchParams.get('team') || 'auto').toUpperCase();
    if (team !== 'AUTO' && !config.teams.some((t) => t.abbr === team)) return json(res, 400, { error: 'team must be auto or a followed team' });
    config.featured = team === 'AUTO' ? null : team;
    saveLocal({ featured: config.featured });
    broadcast('state', screenState());
    return json(res, 200, { featured: config.featured });
  }

  if (url.pathname === '/api/takeover' && req.method === 'POST') {
    const type = String(url.searchParams.get('type') || '').toLowerCase();
    const off = /^(0|off|false)$/i.test(url.searchParams.get('on') || '');
    const event = takeover(type === 'anthem' && off ? 'clear' : type, url.searchParams.get('team'));
    if (!event) return json(res, 400, { error: 'type must be one of touchdown, fieldgoal, safety, twopoint, goal, win, third, defense, anthem, clear' });
    publish(event);
    return json(res, 200, event);
  }

  if (url.pathname === '/api/media') return json(res, 200, { moments: MOMENTS, files: listMedia() });
  if (url.pathname.startsWith('/api/media/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/media/'.length));
    if (req.method === 'PUT') return saveMedia(req, res, name);
    if (req.method === 'DELETE') {
      if (!mediaName(name)) return json(res, 404, { error: 'not found' });
      fs.rmSync(path.join(MEDIA_DIR, name), { force: true });
      broadcast('media', listMedia());
      return json(res, 200, { deleted: name });
    }
  }
  if (url.pathname.startsWith('/media/') && req.method === 'GET') return serveMedia(req, res, decodeURIComponent(url.pathname.slice(7)));

  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, url.pathname);
});

// Last line of defense: log anything unexpected and keep serving the screens.
process.on('uncaughtException', (err) => console.error('uncaught:', err.stack || err.message));
process.on('unhandledRejection', (err) => console.error('unhandled:', (err && err.stack) || err));

// Keep idle connections from timing out behind TV browsers.
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);
setInterval(tick, 1000);

try { migrateMedia(); } catch (err) { console.error('media migration:', err.message); }
try { ensureFavorites(); } catch (err) { console.error('favorite slots:', err.message); }

server.listen(port, () => {
  console.log(`Game Day running on port ${port}, delay ${config.delaySeconds}s, following ${config.teams.map((t) => t.name).join(', ')}`);
  pollLoop();
});

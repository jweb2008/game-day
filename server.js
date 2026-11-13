// Game Day: reads the games you follow, holds them for your TV delay,
// and streams them to the screens in the lounge.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { matchesOf, normalizeField, fetchTeams, fetchScoreboard, fetchTeamSchedule, normalizeEvent, pickFollowed, pickFromSchedule } = require('./lib/espn');
const { DelayBuffer, diffGame } = require('./lib/delay');
const { fetchSummary, pickStats } = require('./lib/stats');
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
  live = { at: new Date().toISOString(), games: all, ticker };
  buffer.push(live);
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

// Box score stats for games that have started. Refreshed every 10s while live, once more at the final.
const statsCache = new Map(); // eventId -> { t, state, stats }

async function addStats(games) {
  const seen = new Set();
  for (const game of Object.values(games)) {
    if (game.kind === 'field' || game.kind === 'match') continue; // no box score to show
    if (game.state === 'pre' || seen.has(game.id)) {
      if (game.state !== 'pre') game.stats = statsCache.get(game.id)?.stats || [];
      continue;
    }
    seen.add(game.id);
    const cached = statsCache.get(game.id);
    const fresh = cached && (cached.state === 'post' || Date.now() - cached.t < 10000);
    if (!fresh) {
      try {
        const summary = await fetchSummary(sportOf(game.league), game.league, game.id);
        statsCache.set(game.id, { t: Date.now(), state: game.state, stats: pickStats(summary, game.league, game.away?.id, game.home?.id) });
      } catch (err) {
        console.error('stats error:', err.message);
      }
    }
    game.stats = statsCache.get(game.id)?.stats || [];
  }
  // Forget games that have dropped off the board.
  const current = new Set(Object.values(games).map((g) => g.id));
  for (const id of statsCache.keys()) if (!current.has(id)) statsCache.delete(id);
}

function busy() {
  const soon = Date.now() + 30 * 60 * 1000;
  return Object.values(live.games).some(
    (g) => g.state === 'in' || (g.state === 'pre' && g.start && Date.parse(g.start) < soon)
  );
}

async function pollLoop() {
  await pollOnce();
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

function screenState() {
  return {
    delaySeconds: config.delaySeconds,
    timeZone: config.timeZone || null,
    buffering: shown === null,
    at: shown ? shown.at : null,
    games: shown ? followedGames(shown.games) : {},
    featured: featured(),
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

function mediaName(name) {
  const m = /^(?:([A-Z]{2,4})-)?([a-z]+)\.([a-z0-9]+)$/.exec(name || '');
  if (!m || !MOMENTS.includes(m[2]) || ![...AUDIO, ...VIDEO, ...IMAGE].includes(m[3])) return null;
  const type = VIDEO.includes(m[3]) ? 'video' : IMAGE.includes(m[3]) ? 'image' : 'audio';
  return { team: m[1] || null, moment: m[2], ext: m[3], type, video: type === 'video' };
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
      if (f.team === info.team && f.moment === info.moment && f.type === info.type) fs.rmSync(path.join(MEDIA_DIR, f.name), { force: true });
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
    });
  }

  if (url.pathname === '/api/delay' && req.method === 'POST') {
    const seconds = Number(url.searchParams.get('seconds'));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) return json(res, 400, { error: 'seconds must be 0 to 120' });
    config.delaySeconds = seconds;
    saveLocal({ delaySeconds: seconds });
    broadcast('state', screenState());
    return json(res, 200, { delaySeconds: seconds });
  }

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
      saveLocal({ watch: config.watch });
      json(res, 200, config.watch);
    }).catch((err) => json(res, 502, { error: err.message }));
    return;
  }

  if (url.pathname === '/api/watch' && req.method === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    config.watch = watchList().filter((w) => String(w.id) !== id);
    saveLocal({ watch: config.watch });
    return json(res, 200, config.watch);
  }

  if (url.pathname === '/api/follow' && req.method === 'POST') {
    const team = String(url.searchParams.get('team') || '').toUpperCase();
    if (!config.teams.some((t) => t.abbr === team)) return json(res, 400, { error: `team must be one of ${config.teams.map((t) => t.abbr).join(', ')}` });
    const on = !/^(0|off|false)$/i.test(url.searchParams.get('on') || '1');
    config.follow = { ...(config.follow || {}), [team]: on };
    saveLocal({ follow: config.follow });
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

// Keep idle connections from timing out behind TV browsers.
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);
setInterval(tick, 1000);

server.listen(port, () => {
  console.log(`Game Day running on port ${port}, delay ${config.delaySeconds}s, following ${config.teams.map((t) => t.name).join(', ')}`);
  pollLoop();
});

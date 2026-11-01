// Game Day: reads the games you follow, holds them for your TV delay,
// and streams them to the screens in the lounge.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchScoreboard, fetchTeamSchedule, pickFollowed, pickFromSchedule } = require('./lib/espn');
const { DelayBuffer, diffGame } = require('./lib/delay');

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

async function nextFromSchedule(lg, abbr) {
  const cached = scheduleCache.get(abbr);
  if (cached && Date.now() - cached.t < 15 * 60 * 1000) return cached.game;
  try {
    const game = pickFromSchedule(await fetchTeamSchedule(lg.sport, lg.league, abbr), lg.league);
    scheduleCache.set(abbr, { t: Date.now(), game });
    return game;
  } catch (err) {
    console.error('schedule error:', err.message);
    return cached ? cached.game : null;
  }
}

async function pollOnce() {
  const games = {};
  for (const lg of leagues()) {
    try {
      const sb = await fetchScoreboard(lg.sport, lg.league);
      Object.assign(games, pickFollowed(sb, lg.league, lg.abbrs));
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
    }
  }
  live = { at: new Date().toISOString(), games };
  buffer.push(live);
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
const clients = new Set();

function send(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(type, data) {
  for (const res of clients) send(res, type, data);
}

function screenState() {
  return {
    delaySeconds: config.delaySeconds,
    buffering: shown === null,
    at: shown ? shown.at : null,
    games: shown ? shown.games : {},
  };
}

function tick() {
  const next = buffer.at(config.delaySeconds * 1000);
  if (!next || next === shown) return;
  if (shown) {
    for (const [abbr, game] of Object.entries(next.games)) {
      for (const ev of diffGame(shown.games[abbr], game)) {
        const event = { ...ev, follow: abbr, game: game.id, league: game.league, at: new Date().toISOString() };
        recentEvents.unshift(event);
        recentEvents.length = Math.min(recentEvents.length, 50);
        console.log('event:', JSON.stringify(event));
        broadcast('game', event);
      }
    }
  }
  shown = next;
  broadcast('state', screenState());
}

// ---- web --------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.json': 'application/json' };

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
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
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
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/state') return json(res, 200, screenState());

  if (url.pathname === '/api/status') {
    return json(res, 200, {
      delaySeconds: config.delaySeconds,
      teams: config.teams,
      liveAt: live.at,
      shownAt: shown ? shown.at : null,
      live: live.games,
      feedError: lastFeedError,
      screens: clients.size,
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

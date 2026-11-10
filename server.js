// Game Day: reads the games you follow, holds them for your TV delay,
// and streams them to the screens in the lounge.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchScoreboard, fetchTeamSchedule, normalizeEvent, pickFollowed, pickFromSchedule } = require('./lib/espn');
const { DelayBuffer, diffGame } = require('./lib/delay');
const { fetchSummary, pickStats } = require('./lib/stats');

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
  await addStats(games);
  live = { at: new Date().toISOString(), games, ticker };
  buffer.push(live);
}

// Box score stats for games that have started. Refreshed every 10s while live, once more at the final.
const statsCache = new Map(); // eventId -> { t, state, stats }

async function addStats(games) {
  const seen = new Set();
  for (const game of Object.values(games)) {
    if (game.state === 'pre' || seen.has(game.id)) {
      if (game.state !== 'pre') game.stats = statsCache.get(game.id)?.stats || [];
      continue;
    }
    seen.add(game.id);
    const cached = statsCache.get(game.id);
    const fresh = cached && (cached.state === 'post' || Date.now() - cached.t < 10000);
    if (!fresh) {
      try {
        const lg = config.teams.find((t) => t.league === game.league);
        const summary = await fetchSummary(lg.sport, game.league, game.id);
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
  if (game.league === 'nhl') return 'goal';
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
}
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
    timeZone: config.timeZone || null,
    buffering: shown === null,
    at: shown ? shown.at : null,
    games: shown ? shown.games : {},
    ticker: shown ? shown.ticker || [] : [],
  };
}

// The newest snapshot events were worked out from. It only moves forward, so making the
// delay longer (the screens step back in time) never replays a score a second time.
let eventBase = null;

function tick() {
  const next = buffer.at(config.delaySeconds * 1000);
  if (!next || next === shown) return;
  const forward = !eventBase || Date.parse(next.at) > Date.parse(eventBase.at);
  if (eventBase && forward) {
    for (const [abbr, game] of Object.entries(next.games)) {
      for (const ev of diffGame(eventBase.games[abbr], game)) {
        const event = { ...ev, follow: abbr, game: game.id, league: game.league, at: new Date().toISOString() };
        if (ev.type === 'score') event.kind = scoreKind(ev, game);
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
  const base = { follow, game: game ? game.id : null, league: game ? game.league : null, at, test: true };
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

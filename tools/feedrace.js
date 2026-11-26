// Feed race: which source shows an NHL goal first, ESPN or the NHL's own live feed?
// Read-only. Doesn't touch the running app. Run it in the game-day console during a game:
//   curl -s -o /tmp/feedrace.js https://raw.githubusercontent.com/jweb2008/game-day/claude/project-thread-wyq9ln/tools/feedrace.js && node /tmp/feedrace.js
// Stop with Ctrl+C. It prints one line per score change and keeps a log in /tmp/feedrace.log,
// plus one raw sample of each feed (/tmp/feedrace-espn.json, /tmp/feedrace-nhl.json) to build tests from.
const fs = require('fs');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';
const NHL = 'https://api-web.nhle.com/v1/score/now';
// NHL team codes ESPN spells differently.
const FIX = { NJD: 'NJ', TBL: 'TB', LAK: 'LA', SJS: 'SJ', UTA: 'UTAH' };
const fix = (a) => FIX[a] || a;
const seen = {}; // "AWY@HOM" -> { espn: "a-h", nhl: "a-h" }
const first = {}; // "AWY@HOM a-h" -> { source, at }
let saved = { espn: false, nhl: false };
const log = (s) => { const line = `${new Date().toLocaleTimeString('en-US', { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')} ${s}`; console.log(line); fs.appendFileSync('/tmp/feedrace.log', line + '\n'); };

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'game-day/1.0' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}
function note(source, key, score) {
  const s = (seen[key] ||= {});
  if (s[source] === score) return;
  const was = s[source];
  s[source] = score;
  if (was === undefined) return log(`${source.padEnd(4)} ${key} starts at ${score}`);
  const k = `${key} ${score}`;
  if (!first[k]) { first[k] = { source, at: Date.now() }; log(`${source.padEnd(4)} ${key} ${was} -> ${score}   FIRST`); }
  else log(`${source.padEnd(4)} ${key} ${was} -> ${score}   ${((Date.now() - first[k].at) / 1000).toFixed(1)} s after ${first[k].source}`);
}
async function tick() {
  const [e, n] = await Promise.allSettled([get(ESPN), get(NHL)]);
  if (e.status === 'fulfilled') {
    if (!saved.espn) { fs.writeFileSync('/tmp/feedrace-espn.json', JSON.stringify(e.value)); saved.espn = true; }
    for (const ev of e.value.events || []) {
      const c = (ev.competitions || [])[0] || {};
      const st = ((ev.status || {}).type || {}).state;
      if (st !== 'in') continue;
      const home = (c.competitors || []).find((x) => x.homeAway === 'home'), away = (c.competitors || []).find((x) => x.homeAway === 'away');
      if (home && away) note('espn', `${away.team.abbreviation}@${home.team.abbreviation}`, `${away.score}-${home.score}`);
    }
  } else log(`espn error: ${e.reason.message}`);
  if (n.status === 'fulfilled') {
    if (!saved.nhl) { fs.writeFileSync('/tmp/feedrace-nhl.json', JSON.stringify(n.value)); saved.nhl = true; }
    for (const g of n.value.games || []) {
      if (!/LIVE|CRIT/.test(g.gameState || '')) continue;
      note('nhl', `${fix(g.awayTeam.abbrev)}@${fix(g.homeTeam.abbrev)}`, `${g.awayTeam.score}-${g.homeTeam.score}`);
    }
  } else log(`nhl error: ${n.reason.message}`);
}
log('feed race started: checking ESPN and the NHL feed every 2 seconds (Ctrl+C to stop)');
(async function loop() { try { await tick(); } catch (err) { log('error: ' + err.message); } setTimeout(loop, 2000); })();

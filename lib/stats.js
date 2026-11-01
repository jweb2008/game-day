// Team stats for the stat bars, from ESPN's game summary (box score).

const ESPN_BASE = process.env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports';

// Which stats to show, in order, and what to call them on the TV.
const PICKS = {
  nfl: [
    ['firstDowns', '1st downs'],
    ['netPassingYards', 'Passing yards'],
    ['rushingYards', 'Rushing yards'],
    ['thirdDownEff', '3rd down'],
    ['redZoneAttempts', 'Red zone'],
    ['turnovers', 'Turnovers'],
    ['possessionTime', 'Possession'],
  ],
  nhl: [
    ['shotsTotal', 'Shots'],
    ['faceoffPercent', 'Faceoffs %'],
    ['powerPlayGoals', 'Power play goals'],
    ['hits', 'Hits'],
    ['blockedShots', 'Blocked shots'],
    ['takeaways', 'Takeaways'],
    ['giveaways', 'Giveaways'],
    ['penaltyMinutes', 'Penalty minutes'],
  ],
};

async function fetchSummary(sport, league, eventId) {
  const url = `${ESPN_BASE}/${sport}/${league}/summary?event=${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'game-day/1.0' } });
  if (!res.ok) throw new Error(`ESPN ${league} summary answered ${res.status}`);
  return res.json();
}

// "4-10" -> 0.4, "31:22" -> 1882 seconds, "57.1" -> 57.1. Used only to size the bars.
function amount(text) {
  if (text == null) return 0;
  const s = String(text).trim();
  let m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : 0;
  m = s.match(/^(\d+):(\d{2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function statMap(teamBox) {
  const map = {};
  for (const s of teamBox.statistics || []) {
    map[s.name] = { label: s.label || s.name, value: s.displayValue ?? String(s.value ?? '') };
  }
  return map;
}

// Returns [{ name, label, away, home, awayAmount, homeAmount }] or [] when the box score is empty.
function pickStats(summary, league, awayId, homeId) {
  const teams = (summary.boxscore && summary.boxscore.teams) || [];
  const find = (id, fallback) => teams.find((t) => String(t.team && t.team.id) === String(id)) || teams[fallback];
  const awayBox = find(awayId, 0);
  const homeBox = find(homeId, 1);
  if (!awayBox || !homeBox) return [];
  const a = statMap(awayBox);
  const h = statMap(homeBox);

  let picks = (PICKS[league] || []).filter(([name]) => a[name] && h[name]);
  // A league we haven't tuned, or ESPN renamed things: show whatever numbers it has.
  if (picks.length < 3) {
    picks = Object.keys(a).filter((n) => h[n] && amount(a[n].value) + amount(h[n].value) > 0).slice(0, 8).map((n) => [n, a[n].label]);
  }
  return picks.map(([name, label]) => ({
    name,
    label,
    away: a[name].value,
    home: h[name].value,
    awayAmount: amount(a[name].value),
    homeAmount: amount(h[name].value),
  }));
}

module.exports = { fetchSummary, pickStats, amount };

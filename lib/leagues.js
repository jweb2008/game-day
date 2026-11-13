// Leagues the calendar can browse. `key` is ESPN's name for the league in its addresses.
// `scoring` says which scores get a takeover: every football touchdown and field goal, every
// hockey or soccer goal; basketball and baseball score too often, so only their wins celebrate.

const LEAGUES = [
  { key: 'nfl', sport: 'football', name: 'NFL', scoring: 'football' },
  { key: 'nhl', sport: 'hockey', name: 'NHL', scoring: 'goals' },
  { key: 'nba', sport: 'basketball', name: 'NBA', scoring: 'none' },
  { key: 'mlb', sport: 'baseball', name: 'MLB', scoring: 'none' },
  { key: 'wnba', sport: 'basketball', name: 'WNBA', scoring: 'none' },
  { key: 'college-football', sport: 'football', name: 'College football', scoring: 'football', groups: '80' },
  { key: 'mens-college-basketball', sport: 'basketball', name: "Men's college basketball", scoring: 'none', groups: '50' },
  { key: 'womens-college-basketball', sport: 'basketball', name: "Women's college basketball", scoring: 'none', groups: '50' },
  { key: 'mens-college-hockey', sport: 'hockey', name: "Men's college hockey", scoring: 'goals' },
  { key: 'usa.1', sport: 'soccer', name: 'MLS', scoring: 'goals' },
  { key: 'eng.1', sport: 'soccer', name: 'Premier League', scoring: 'goals' },
];

const BY_KEY = Object.fromEntries(LEAGUES.map((l) => [l.key, l]));
const league = (key) => BY_KEY[key] || null;

module.exports = { LEAGUES, league };

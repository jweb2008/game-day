// Everything the calendar can browse. `key` is ESPN's name for the league in its addresses.
// kind: 'team' (two teams, the normal scoreboard), 'match' (two players or fighters: tennis, UFC),
// 'field' (a whole field on a leaderboard: golf, racing).
// scoring: which scores get a takeover. Football touchdowns and field goals, hockey, soccer and
// lacrosse goals; basketball and baseball score too often, so only their wins celebrate.

const L = (sport, key, name, kind, scoring, extra = {}) => ({ sport, key, name, kind, scoring, ...extra });

const LEAGUES = [
  L('football', 'nfl', 'NFL', 'team', 'football'),
  L('football', 'college-football', 'College football', 'team', 'football', { groups: '80' }),
  L('football', 'cfl', 'CFL', 'team', 'football'),
  L('football', 'ufl', 'UFL', 'team', 'football'),

  L('hockey', 'nhl', 'NHL', 'team', 'goals'),
  L('hockey', 'mens-college-hockey', "Men's college hockey", 'team', 'goals'),
  L('hockey', 'womens-college-hockey', "Women's college hockey", 'team', 'goals'),

  L('basketball', 'nba', 'NBA', 'team', 'none'),
  L('basketball', 'wnba', 'WNBA', 'team', 'none'),
  L('basketball', 'mens-college-basketball', "Men's college basketball", 'team', 'none', { groups: '50' }),
  L('basketball', 'womens-college-basketball', "Women's college basketball", 'team', 'none', { groups: '50' }),
  L('basketball', 'nba-development', 'G League', 'team', 'none'),

  L('baseball', 'mlb', 'MLB', 'team', 'none'),
  L('baseball', 'college-baseball', 'College baseball', 'team', 'none'),
  L('softball', 'college-softball', 'College softball', 'team', 'none'),

  L('soccer', 'usa.1', 'MLS', 'team', 'goals'),
  L('soccer', 'usa.nwsl', 'NWSL', 'team', 'goals'),
  L('soccer', 'eng.1', 'Premier League', 'team', 'goals'),
  L('soccer', 'esp.1', 'LaLiga', 'team', 'goals'),
  L('soccer', 'ger.1', 'Bundesliga', 'team', 'goals'),
  L('soccer', 'ita.1', 'Serie A', 'team', 'goals'),
  L('soccer', 'fra.1', 'Ligue 1', 'team', 'goals'),
  L('soccer', 'mex.1', 'Liga MX', 'team', 'goals'),
  L('soccer', 'uefa.champions', 'Champions League', 'team', 'goals'),
  L('soccer', 'uefa.europa', 'Europa League', 'team', 'goals'),
  L('soccer', 'fifa.world', 'World Cup', 'team', 'goals'),

  L('lacrosse', 'mens-college-lacrosse', "Men's college lacrosse", 'team', 'goals'),
  L('lacrosse', 'womens-college-lacrosse', "Women's college lacrosse", 'team', 'goals'),
  L('lacrosse', 'pll', 'PLL', 'team', 'goals'),

  L('volleyball', 'womens-college-volleyball', "Women's college volleyball", 'team', 'none'),

  L('tennis', 'atp', 'Tennis (men)', 'match', 'none'),
  L('tennis', 'wta', 'Tennis (women)', 'match', 'none'),
  L('mma', 'ufc', 'UFC', 'match', 'none'),

  L('golf', 'pga', 'PGA Tour', 'field', 'none'),
  L('golf', 'lpga', 'LPGA', 'field', 'none'),
  L('golf', 'liv', 'LIV Golf', 'field', 'none'),
  L('racing', 'nascar-premier', 'NASCAR Cup', 'field', 'none'),
  L('racing', 'irl', 'IndyCar', 'field', 'none'),
  L('racing', 'f1', 'Formula 1', 'field', 'none'),
];

// How the calendar groups them.
const SPORTS = [
  ['football', 'Football'], ['hockey', 'Hockey'], ['basketball', 'Basketball'], ['baseball', 'Baseball'],
  ['softball', 'Softball'], ['soccer', 'Soccer'], ['lacrosse', 'Lacrosse'], ['volleyball', 'Volleyball'],
  ['golf', 'Golf'], ['racing', 'Racing'], ['tennis', 'Tennis'], ['mma', 'UFC'],
];

const BY_KEY = Object.fromEntries(LEAGUES.map((l) => [l.key, l]));
const league = (key) => BY_KEY[key] || null;

module.exports = { LEAGUES, SPORTS, league };

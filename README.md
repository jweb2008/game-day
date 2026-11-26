# Game Day

Screens and light cues for the sports lounge. Reads ESPN's public scoreboard for the
teams in `config.json`, holds every update for the TV delay, and streams it to the
screens over Server-Sent Events. No npm packages; Node.js 18 or newer.

## Install (on the Proxmox container)

```bash
apt update && apt install -y curl
bash -c "$(curl -fsSL https://raw.githubusercontent.com/jweb2008/game-day/main/install.sh)"
```

## Update

```bash
bash /opt/game-day/update.sh
```

## Pages and endpoints

| Path | What it is |
| --- | --- |
| `/` | Status page: followed games (delayed), feed health, recent events |
| `/scoreboard.html` | Portrait scoreboard for a TV; `?team=KC` picks a game, otherwise live, then next, then latest final |
| `/scoreboard.html?side=away` (or `side=home`) | Team screen for one side: that team's colors, floating logo, score, possession, its own stats; same takeovers. Left TCL away, right TCL home |
| `/projector.html` | Projector logo page: the featured team's logo in team colors, logos only on pure black so just the logo shows on the ceiling (`?size=70` logo size as a share of the image height, default 92; `?glow=1` team-color glow; `?bug=1` score box; `?takeovers=0` skips takeovers). A game without one of your teams (a calendar pick) is a battle: both logos float and charge each other, the team ahead a little bigger, the loser fading at the final (`?duel=0` turns it off); landscape |
| `/calendar.html` | Calendar: pick a sport, league, day and game (39 leagues: team sports, tennis and UFC matches, golf and racing events) to watch, and who the room cheers for. The game joins the screens 3 hours before start (ahead of your own teams) and leaves 90 minutes after the final |
| `GET /api/leagues`, `GET /api/calendar?league=nfl&date=20261115`, `GET/POST/DELETE /api/watch` | Calendar data and the watch list (saved in `config.local.json`) |
| `/scoreboard.html?view=field` | Field view for a wide screen (football): the drive on a field, line of scrimmage, first-down line, last play with headshots; the scoring drive for a minute after a score. Other sports and pregame show the logo page |
| `/api/debug/summary?game=<id>` | What the app read from ESPN's game summary (`&raw=1` for the raw JSON), for troubleshooting |
| `/slots.html` | Game slots, for a Webpage card on the Home Assistant dashboard: fifteen slots in priority order holding your teams or calendar picks. The highest live slot stays on the screens; other live slots show only while it is at halftime, an intermission or the end of a period, taking turns (every 5 min by default). With none live, the highest slot with a game coming up shows. "Show now" (`POST /api/slots?pin=KEY`, `pin=` to clear) holds one game until cleared. Other games' score changes flash on the ticker. Calendar picks fill the first empty slot. The dashboard's Featured game, when set, still wins |
| `GET /api/slots`, `POST /api/slots?set=BOS,KC,,NE` / `?cycle=5` | Slot contents and the rotation time (saved in `config.local.json`) |
| Team screens, pregame | Panels rotate (`?precycle=` seconds): last 5 + players to watch, matchup, spotlight (top player's last 5 games), division, wild card race, conference, league standings |
| Team screens, postgame | Final with WIN on the winner's side; panel rotates game stats, three stars (hockey: worked out from the box score; football: top passer, rusher, receiver) and the team's next game. Pregame also rotates in "Last 5 · Next 5" (next five opponents with records) |
| Team screens, in game | Left (away) top bar: period and clock; right (home): down and distance in football. Panel alternates team stats with the drive chart (football) or that team's player box score (hockey) |
| `/stream` | Live stream for screens (`state` and `game` events) |
| `/api/status` | Feed, delay and recent events as JSON |
| `POST /api/delay?seconds=12` | Change the delay (saved in `config.local.json`); Home Assistant's delay slider calls this |
| `GET /api/busy` | `{busy}`: a followed or picked game is on or starts within 90 minutes (the nightly update waits) |
| `POST /api/sync` | Tap the moment a score happens on your TV: sets the delay to how long ago the app saw that score (newest score in the game on the screens; `?game=<id>` picks one) and sends `{type: 'delay', seconds}` to Home Assistant so the Goal delay slider follows. `GET` lists the scores it could sync to |
| `POST /api/follow?team=NE&on=0` | Follow switch: an unfollowed team is left off the screens and sends no events (Home Assistant sets this) |
| `POST /api/featured?team=KC` | Game picker: which followed team the screens show; `team=auto` for live first |
| `POST /api/takeover?type=touchdown&team=KC` | Show a takeover now. Types: touchdown, fieldgoal, safety, twopoint, goal, win, third, defense, anthem, clear |
| `POST /api/doorbell` | Doorbell: Game Day fetches Home Assistant's snapshot (`http://<homeAssistant.url>/local/doorbell.jpg`, or `?image=<url>`; `?image=none` for no picture) and every screen shows a "Front door" card with it for 30 seconds, over the game, with a chime on screens that have sound. The projector skips it (`?doorbell=1` to show it there), any screen can skip it with `?doorbell=0`, and `"doorbell": {"enabled": false}` in `config.local.json` turns it off. `GET /api/doorbell` shows the last ring and any picture error |
| `GET /api/media`, `PUT`/`DELETE /api/media/KC-touchdown.mp4` | Sounds and videos for takeovers (the status page has an upload form) |

## Home Assistant

Every event (scores with their kind, 3rd downs, finals, and test takeovers) is POSTed as JSON to
`{homeAssistant.url}/api/webhook/{homeAssistant.webhook}` (see `config.json`) at the moment the screens
show it, already on the delay. A relay automation in Home Assistant turns each one into a `game_day`
event, and the light automations trigger on those, so lights and screens fire together.

## Takeovers

When a team you follow scores or wins, the scoreboard screens switch to a full-screen takeover on the
same delay as the scoreboard: TOUCHDOWN, FIELD GOAL, SAFETY, GOAL (with a spinning goal light) and WIN
(confetti, final score). A 2-point conversion and each new 3rd down get a banner over the scoreboard
instead (DEFENSE when the other team has the ball). Scores and 3rd downs show only for the game a screen
is showing; wins show for every team you follow.

Sounds and videos are optional and live in `media/` (outside git). Name them for the moment, and
optionally the team: `touchdown.mp4`, `KC-touchdown.mp3`, `BOS-win.mp3`, `defense.mp3`, `anthem.mp4`.
Pictures (PNG, JPG, GIF, WebP) work too: on a score they replace the team logo, and for the anthem a
picture or video replaces the built-in flag (anthem videos play muted, since the anthem is on TV).
A team logo picture (`nhl_BOS-logo.webp`) replaces ESPN's logo for that team on every screen. Team files carry the league as well as the abbreviation, so the Bruins' files never show up for the Celtics (both are BOS). Files saved before this (`BOS-logo.webp`) are renamed to the league of the team you follow at start-up.
A team's own file wins over the general one. Add `?sound=0` to any screen that should stay quiet.

Per-house overrides go in `config.local.json` next to `config.json` (not tracked in git).

## Ticker

The bottom ticker scrolls every game in the leagues of your teams, plus the leagues in
`tickerLeagues` in `config.json` (NBA by default; add more by ESPN key, like `"mlb"` or `"wnba"`).
Ticker-only leagues are read every 15 seconds. With more than one league on it, each game carries a
small league tag. Baseball scores scroll without an alert. Basketball alerts only for the moments
that change a game (`lib/momentum.js`, tests in `test/`): a scoring run (outscoring the other team
by 12 or more while scoring at least three times as much, like 12-0, 15-3 or 26-3, and again every
10 more points of margin), and a lead change in the last two minutes of the 4th quarter or overtime.
The alert bar reads "RUN · BOS on a 26-3 run" or "LEAD · BOS takes the lead".

## Game clock

ESPN only sends a new clock reading every 10 to 15 seconds. The screens count the clock down
themselves between readings (football, hockey, basketball, lacrosse) and correct to each new one.
When readings stop changing, the clock has stopped, and the screens settle on ESPN's stopped time;
at a whistle the clock can run on for about one reading gap before it settles. Sync the delay to
scores (`/api/sync`), not to the clock. During games the feed is checked every 2 seconds.

## Updates

`bash /opt/game-day/update.sh` pulls the newest code and restarts. Updates build on each other: one
run catches everything since the last. `bash /opt/game-day/enable-auto-update.sh` turns on a nightly
run at 4:00 AM Mountain (`update.sh --auto`) that only restarts when there's something new and no game
is on or starting within 90 minutes. Each run is logged to `update-log.json` and shown on the status
page. Turn it off with `systemctl disable --now game-day-update.timer`. Home Assistant changes are
never automatic; they're listed in the build plan's checklist.

## Between games

With nothing live, a game that just ended keeps the screens (postgame stats, stars, and an "Up next
on the screens" teaser for the next slot game) while the next game is at least 15 minutes away, for
up to 90 minutes. Back to back (under 15 minutes): straight to the next game's pregame.

Followed teams always get a slot of their own (it holds that team's current or next game), so their
games come up without a calendar pick. Empty a team's slot on the dashboard and it stays out until
you add it back.

## Scorers and scoring plays

A score's takeover and the lights go out the moment ESPN's scoreboard shows the score. Nothing waits
for who scored. The app sends the scores first, then reads game summaries, standings and game logs.
The scorer gets a player card instead: headshot, name, the play ("goal 5 · wrist shot · from
Pastrnak, McAvoy") and their game so far ("2 G · 1 A · 5 SOG", "14 car · 82 yds · 1 TD"). It slides
up about when the broadcast runs its first replay: `scorerCardSeconds` after the delayed score
(default 20, set it in `config.local.json`). If a goal song is still playing, the card waits for it.
It stays up for 12 seconds (`?cardsecs=` on a screen). It goes to the screens only. Home Assistant
already got the score. Test buttons use your team's most recent real scorer when there is one.
Football and hockey team TVs list the scoring plays so far under the team stats (newest first, never
ahead of the delayed score). Football TVs also show timeouts left under the score.

## Hockey goals: the NHL's own feed

ESPN's free feed runs well behind the broadcast, so during an NHL game the app also reads the
NHL's live scores (api-web.nhle.com) at the same moment as ESPN, every poll. Whichever has the goal
first raises the score, and the takeover, lights and Home Assistant event go out then. The goal only
fires once, even when ESPN catches up later. A goal the NHL feed shows and then takes back on review
comes off after three reads. Scorer, clock, stats and finals still come from ESPN. The status page
JSON (/api/status) shows `nhlFeed` with the last error and the last goal the NHL feed had before ESPN.
Turn it off with `"nhlFeed": false` in config.local.json.

`tools/feedrace.js` times the two feeds against each other during a game without touching the app.

## Hockey goals: through the ice

A hockey goal takeover starts as a sheet of ice over the screen. It cracks from one point, then
shatters, and the pieces fly off to show the GOAL screen. There is a short ice-breaking sound unless
the screen has `?sound=0`. Your own goal song still plays over it. `?ice=0` turns the ice off on a
screen. The projector's logo page skips it.

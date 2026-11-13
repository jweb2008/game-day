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
| `/projector.html` | Projector logo page: the featured team's logo in team colors, logos only (`?bug=1` adds a small score box, `?takeovers=0` skips takeovers); landscape |
| `/calendar.html` | Calendar: pick a sport, league, day and game (39 leagues: team sports, tennis and UFC matches, golf and racing events) to watch, and who the room cheers for. The game joins the screens 3 hours before start (ahead of your own teams) and leaves 90 minutes after the final |
| `GET /api/leagues`, `GET /api/calendar?league=nfl&date=20261115`, `GET/POST/DELETE /api/watch` | Calendar data and the watch list (saved in `config.local.json`) |
| `/scoreboard.html?view=field` | Field view for a wide screen (football): the drive on a field, line of scrimmage, first-down line, last play with headshots; the scoring drive for a minute after a score. Other sports and pregame show the logo page |
| `/api/debug/summary?game=<id>` | What the app read from ESPN's game summary (`&raw=1` for the raw JSON), for troubleshooting |
| `/stream` | Live stream for screens (`state` and `game` events) |
| `/api/status` | Feed, delay and recent events as JSON |
| `POST /api/delay?seconds=12` | Change the delay (saved in `config.local.json`); Home Assistant's delay slider calls this |
| `POST /api/follow?team=NE&on=0` | Follow switch: an unfollowed team is left off the screens and sends no events (Home Assistant sets this) |
| `POST /api/featured?team=KC` | Game picker: which followed team the screens show; `team=auto` for live first |
| `POST /api/takeover?type=touchdown&team=KC` | Show a takeover now. Types: touchdown, fieldgoal, safety, twopoint, goal, win, third, defense, anthem, clear |
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
A team logo picture (`BOS-logo.webp`) replaces ESPN's logo for that team on every screen.
A team's own file wins over the general one. Add `?sound=0` to any screen that should stay quiet.

Per-house overrides go in `config.local.json` next to `config.json` (not tracked in git).

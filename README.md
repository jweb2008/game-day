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
| `/stream` | Live stream for screens (`state` and `game` events) |
| `/api/status` | Feed, delay and recent events as JSON |
| `POST /api/delay?seconds=12` | Change the delay (saved in `config.local.json`) |

Per-house overrides go in `config.local.json` next to `config.json` (not tracked in git).

#!/usr/bin/env bash
# Pulls the newest Game Day code and restarts it.
#   bash /opt/game-day/update.sh          update now (by hand)
#   bash /opt/game-day/update.sh --auto   the nightly run: skips while a game is on, logs what it did
# Everything is inside main() so bash has read the whole script before git pull replaces this file.
set -uo pipefail

main() {
  local DIR="${GAME_DAY_DIR:-/opt/game-day}" AUTO=0
  [ "${1:-}" = "--auto" ] && AUTO=1
  cd "$DIR" || exit 1

  # Write one line to update-log.json (the status page shows the newest ones).
  log() {
    RESULT="$1" DETAIL="$2" FROM="${3:-}" TO="${4:-}" AUTO="$AUTO" node -e '
      const fs = require("fs"); const f = "update-log.json";
      let list = []; try { list = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      list.unshift({ at: new Date().toISOString(), auto: process.env.AUTO === "1", result: process.env.RESULT,
        detail: process.env.DETAIL, from: process.env.FROM || null, to: process.env.TO || null });
      fs.writeFileSync(f, JSON.stringify(list.slice(0, 20), null, 2));'
    echo "$1: $2"
  }

  if ! git fetch -q origin 2>/tmp/game-day-fetch.err; then
    log failed "Couldn't reach GitHub: $(tail -1 /tmp/game-day-fetch.err)"
    return 1
  fi
  local OLD NEW
  OLD="$(git rev-parse HEAD)"
  NEW="$(git rev-parse '@{u}')"
  if [ "$OLD" = "$NEW" ]; then
    [ $AUTO = 1 ] && log current "Already up to date" "$OLD" "$OLD"
    [ $AUTO = 0 ] && { systemctl restart game-day; echo "Already up to date. Restarted Game Day."; }
    return 0
  fi

  # Nightly run: never restart the screens during a game. Try again the next night.
  if [ $AUTO = 1 ]; then
    local PORT BUSY
    PORT="$(node -e 'const fs=require("fs");let c=JSON.parse(fs.readFileSync("config.json","utf8"));try{Object.assign(c,JSON.parse(fs.readFileSync("config.local.json","utf8")))}catch{};console.log(c.port||80)')"
    BUSY="$(curl -s -m 5 "http://localhost:$PORT/api/busy" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).busy?"yes":"no")}catch{console.log("no")}})')"
    if [ "$BUSY" = "yes" ]; then
      log skipped "A game is on or starting soon; will try again tomorrow night" "$OLD" "$NEW"
      return 0
    fi
  fi

  local CHANGES
  CHANGES="$(git log --format='%s' "$OLD..$NEW" 2>/dev/null | head -20 | paste -sd ';' -)"
  if ! git merge -q --ff-only "$NEW" 2>/tmp/game-day-merge.err; then
    log failed "Couldn't apply the update, still running the old version: $(tail -1 /tmp/game-day-merge.err)" "$OLD" "$NEW"
    return 1
  fi
  systemctl restart game-day
  log updated "${CHANGES:-New version}" "$OLD" "$NEW"
  echo "Game Day updated and restarted."
}

main "$@"
exit $?

#!/usr/bin/env bash
# Turns on the nightly update: every night at 4:00 AM Mountain time the game-day container runs
# update.sh --auto, which updates and restarts Game Day only if there's something new and no game
# is on. Safe to run again. To turn it off: systemctl disable --now game-day-update.timer
set -euo pipefail
cat > /etc/systemd/system/game-day-update.service <<UNIT
[Unit]
Description=Game Day nightly update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash /opt/game-day/update.sh --auto
UNIT
cat > /etc/systemd/system/game-day-update.timer <<UNIT
[Unit]
Description=Game Day nightly update, 4:00 AM Mountain

[Timer]
OnCalendar=*-*-* 04:00:00 America/Denver
Persistent=true

[Install]
WantedBy=timers.target
UNIT
command -v curl >/dev/null || apt-get install -y -qq curl >/dev/null
systemctl daemon-reload
systemctl enable --now game-day-update.timer >/dev/null
echo "Nightly update is on. Next run: $(systemctl show game-day-update.timer -p NextElapseUSecRealtime --value)"

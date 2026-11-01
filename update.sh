#!/usr/bin/env bash
# Pulls the newest Game Day code and restarts it.
set -euo pipefail
git -C /opt/game-day pull --ff-only
systemctl restart game-day
echo "Game Day updated and restarted."

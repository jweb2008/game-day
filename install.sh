#!/usr/bin/env bash
# Installs Game Day on a fresh Debian container. Safe to run again.
set -euo pipefail

REPO="https://github.com/jweb2008/game-day.git"
DIR="/opt/game-day"

echo "==> Installing Node.js and git"
apt-get update -qq
apt-get install -y -qq nodejs git ca-certificates >/dev/null

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js $NODE_MAJOR is too old (need 18 or newer)." >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "==> Updating existing copy in $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "==> Downloading Game Day to $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

echo "==> Setting it to start automatically"
cat > /etc/systemd/system/game-day.service <<EOF
[Unit]
Description=Game Day screens
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now game-day >/dev/null
systemctl restart game-day

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Game Day is running. Open http://$IP on any computer at home."

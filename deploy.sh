#!/usr/bin/env bash
#
# Redeploy the WhatsApp forwarder to the EC2 instance:
#   sync local baileys/ -> instance, install deps, restart pm2.
#
# Workflow: edit baileys/config.json (or code) LOCALLY, then run ./deploy.sh
# The local copy is the source of truth — this overwrites the instance's copy.
# Your linked session (auth/) and node_modules on the instance are never touched.
#
set -euo pipefail
cd "$(dirname "$0")"
source ./instance.env

SRC="$(pwd)/baileys/"
SSH_OPTS=(-i "$WA_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

echo "→ syncing code to $WA_USER@$WA_HOST:~/wa-forward"
rsync -az --delete \
  --exclude node_modules --exclude auth --exclude '*.log' --exclude .env \
  -e "ssh ${SSH_OPTS[*]}" \
  "$SRC" "$WA_USER@$WA_HOST:~/wa-forward/"

echo "→ installing deps + restarting pm2"
ssh "${SSH_OPTS[@]}" "$WA_USER@$WA_HOST" APP="$WA_APP" 'bash -s' <<'REMOTE'
set -e
cd ~/wa-forward
npm install --no-audit --no-fund --silent
pm2 restart "$APP" --update-env 2>/dev/null || pm2 start index.js --name "$APP"
pm2 save
pm2 status "$APP"
REMOTE

echo "✓ deployed. Tail logs:  ./connect.sh pm2 logs $WA_APP"

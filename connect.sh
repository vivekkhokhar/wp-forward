#!/usr/bin/env bash
#
# SSH into the WhatsApp forwarder EC2 instance (so you never have to remember the IP).
#
#   ./connect.sh                  # open an interactive shell on the instance
#   ./connect.sh pm2 logs wa-forward   # run a command and exit
#
set -euo pipefail
cd "$(dirname "$0")"
source ./instance.env
exec ssh -i "$WA_KEY" "$WA_USER@$WA_HOST" "$@"

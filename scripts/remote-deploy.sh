#!/usr/bin/env bash
# Runs on the EC2 instance via GitHub Actions SSH.
# Pulls latest code, rebuilds the app, and restarts the service.
set -euo pipefail

export PATH="/usr/local/bin:$PATH"
APP_DIR="/opt/atm-command"

echo "==> [1/4] Pulling latest code..."
cd "$APP_DIR"
git pull origin main

echo "==> [2/4] Rebuilding..."
./build.sh

echo "==> [3/4] Restarting service..."
sudo systemctl restart atm-command

echo "==> [4/4] Verifying service is running..."
sleep 3
sudo systemctl status atm-command --no-pager

echo ""
echo "Deploy complete at $(date)"

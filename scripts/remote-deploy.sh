#!/usr/bin/env bash
# Runs on the EC2 instance via GitHub Actions SSH.
# Pulls latest code, rebuilds the app, and restarts the service.
set -euo pipefail

export PATH="/usr/local/bin:$PATH"
APP_DIR="/opt/atm-command"

echo "==> [1/5] Checking system dependencies..."
# Install Chromium + required libs for Puppeteer (idempotent)
if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null && ! command -v google-chrome &>/dev/null; then
  echo "    Installing Chromium..."
  sudo apt-get update -q
  sudo apt-get install -y -q \
    chromium-browser \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
    libgdk-pixbuf2.0-0 libgtk-3-0 fonts-liberation \
    libappindicator3-1 xdg-utils 2>/dev/null || true
else
  echo "    Chromium already installed, skipping."
fi

# Tell Puppeteer to use the system Chromium instead of downloading its own
CHROMIUM_PATH="$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || command -v google-chrome 2>/dev/null || true)"
if [ -n "$CHROMIUM_PATH" ]; then
  echo "    Chromium found at: $CHROMIUM_PATH"
  # Persist in the service environment file if not already there
  SERVICE_ENV="/opt/atm-command/.env"
  if ! grep -q "^CHROMIUM_PATH=" "$SERVICE_ENV" 2>/dev/null; then
    echo "CHROMIUM_PATH=$CHROMIUM_PATH" >> "$SERVICE_ENV"
    echo "    Added CHROMIUM_PATH to .env"
  fi
  # Also tell Puppeteer to skip its own Chrome download
  if ! grep -q "^PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=" "$SERVICE_ENV" 2>/dev/null; then
    echo "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true" >> "$SERVICE_ENV"
  fi
fi

echo "==> [2/5] Pulling latest code..."
cd "$APP_DIR"
git pull origin main

echo "==> [3/5] Rebuilding..."
./build.sh

echo "==> [4/5] Restarting service..."
sudo systemctl restart atm-command

echo "==> [5/5] Verifying service is running..."
sleep 3
sudo systemctl status atm-command --no-pager

echo ""
echo "Deploy complete at $(date)"

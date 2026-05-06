#!/usr/bin/env bash
# Runs on the EC2 instance via GitHub Actions SSH.
# Pulls latest code, rebuilds the app, and restarts the service.
set -euo pipefail

export PATH="/usr/local/bin:$PATH"
APP_DIR="/opt/atm-command"

echo "==> [1/5] Checking system dependencies..."
# On Ubuntu 22.04+, `chromium-browser` is a snap wrapper which CANNOT be launched
# from a systemd service (snap cgroup restriction). Install Google Chrome from
# Google's official apt repo instead — it's a real .deb with no cgroup restrictions.
SERVICE_ENV="/opt/atm-command/.env"

if ! command -v google-chrome-stable &>/dev/null && ! command -v google-chrome &>/dev/null; then
  echo "    Installing Google Chrome (non-snap)..."
  # Add Google's signing key and apt source
  wget -q -O /tmp/linux_signing_key.pub https://dl.google.com/linux/linux_signing_key.pub
  sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg /tmp/linux_signing_key.pub 2>/dev/null || \
    sudo apt-key add /tmp/linux_signing_key.pub 2>/dev/null || true
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    | sudo tee /etc/apt/sources.list.d/google-chrome.list > /dev/null
  sudo apt-get update -q
  sudo apt-get install -y -q google-chrome-stable 2>/dev/null || \
    sudo apt-get install -y -q google-chrome 2>/dev/null || true

  # Also install Puppeteer shared-library deps
  sudo apt-get install -y -q \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
    libgdk-pixbuf2.0-0 libgtk-3-0 fonts-liberation xdg-utils 2>/dev/null || true
else
  echo "    Google Chrome already installed."
fi

# Pin the Chrome executable path in .env so the Node.js process always finds it
CHROME_BIN="$(command -v google-chrome-stable 2>/dev/null || command -v google-chrome 2>/dev/null || true)"
if [ -n "$CHROME_BIN" ]; then
  echo "    Chrome found at: $CHROME_BIN"
  # Update or add CHROMIUM_PATH in .env
  if grep -q "^CHROMIUM_PATH=" "$SERVICE_ENV" 2>/dev/null; then
    sed -i "s|^CHROMIUM_PATH=.*|CHROMIUM_PATH=$CHROME_BIN|" "$SERVICE_ENV"
  else
    echo "CHROMIUM_PATH=$CHROME_BIN" >> "$SERVICE_ENV"
  fi
  # Ensure Puppeteer doesn't try to download its own Chrome
  if ! grep -q "^PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=" "$SERVICE_ENV" 2>/dev/null; then
    echo "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true" >> "$SERVICE_ENV"
  fi
  echo "    CHROMIUM_PATH set to $CHROME_BIN in .env"
fi

echo "==> [2/5] Pulling latest code..."
cd "$APP_DIR"
git pull origin main

echo "==> [3/5] Rebuilding..."
./build.sh

echo "==> [3b] Running DB migrations..."
# Push any new schema changes (new tables, columns) to the database
source "$APP_DIR/.env" 2>/dev/null || true
export DATABASE_URL NODE_ENV
cd "$APP_DIR/lib/db"
NODE_ENV=production npx drizzle-kit push --force 2>&1 || echo "  (drizzle push failed, continuing)"
cd "$APP_DIR"

echo "==> [4/5] Restarting service..."
sudo systemctl restart atm-command

echo "==> [5/5] Verifying service is running..."
sleep 3
sudo systemctl status atm-command --no-pager

echo ""
echo "Deploy complete at $(date)"

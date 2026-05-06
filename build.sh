#!/usr/bin/env bash
set -euo pipefail
export CI=true
# Tell Puppeteer to use system Chromium instead of downloading its own ~300 MB Chrome binary.
# CHROMIUM_PATH is set by remote-deploy.sh; on dev machines this is a no-op.
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

echo "==> Installing dependencies..."
pnpm install --no-frozen-lockfile

echo "==> Building backend..."
pnpm --filter @workspace/api-server run build

echo "==> Building frontend..."
BASE_PATH=/ PORT=3001 pnpm --filter @workspace/atm-dashboard run build

echo "==> Copying frontend into server dist..."
mkdir -p artifacts/api-server/dist/public
cp -r artifacts/atm-dashboard/dist/public/. artifacts/api-server/dist/public/

echo ""
echo "Build complete. Run ./start.sh to start the server."

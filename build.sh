#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building backend..."
pnpm --filter @workspace/api-server run build

echo "==> Building frontend..."
BASE_PATH=/ PORT=3001 pnpm --filter @workspace/atm-dashboard run build

echo "==> Copying frontend into server dist..."
mkdir -p artifacts/api-server/dist/public
cp -r artifacts/atm-dashboard/dist/public/. artifacts/api-server/dist/public/

echo ""
echo "Build complete. Run ./start.sh to start the server."

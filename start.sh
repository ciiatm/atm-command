#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${PORT:=3000}"

echo "==> Pushing database schema..."
pnpm --filter @workspace/db run push

echo "==> Starting ATM Command server on port $PORT..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs

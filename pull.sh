#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "fetching latest main..."
git fetch origin main
git reset --hard origin/main

echo "installing deps..."
npm install

echo "restarting server..."
pkill -f "node server/index.mjs" || true
sleep 1
nohup node server/index.mjs > server.log 2>&1 &
disown

echo "deployed $(git rev-parse --short HEAD)"

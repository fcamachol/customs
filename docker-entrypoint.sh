#!/bin/sh
# Container entrypoint: run database migrations, then start the API server.
# node-pg-migrate and tsx read DATABASE_URL and other config from the environment.
set -e

cd /app/server

echo "[entrypoint] Running database migrations..."
n=0
until node_modules/.bin/node-pg-migrate up --tsx -m migrations; do
  n=$((n + 1))
  if [ "$n" -ge 10 ]; then
    echo "[entrypoint] Migrations failed after $n attempts — aborting."
    exit 1
  fi
  echo "[entrypoint] Migration attempt $n failed (DB not ready?). Retrying in 3s..."
  sleep 3
done

# Optional one-shot user seed. Runs only when SEED_USERS_B64 is set (base64 of a
# JSON array of [username, password, role]); idempotent upsert. Unset after seeding.
if [ -n "$SEED_USERS_B64" ]; then
  echo "[entrypoint] SEED_USERS_B64 present — seeding users..."
  node_modules/.bin/tsx scripts/seedUsers.ts
fi

echo "[entrypoint] Migrations complete. Starting API on :${PORT:-4000}..."
exec node_modules/.bin/tsx src/index.ts

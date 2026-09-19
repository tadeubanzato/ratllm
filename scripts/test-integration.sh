#!/usr/bin/env bash
# Runs the integration suite against a disposable PostgreSQL container. Needs Docker; touches nothing else.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=ratllm-test-pg
PORT=55432
export DATABASE_URL="postgresql://postgres:test@localhost:${PORT}/postgres"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test -p "127.0.0.1:${PORT}:5432" postgres:17-alpine >/dev/null
for _ in $(seq 1 40); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 0.5
done
# pg_isready answers during initdb's temporary server; wait until the real one accepts a query too.
for _ in $(seq 1 40); do
  docker exec "$NAME" psql -U postgres -Atc "select 1" >/dev/null 2>&1 && break
  sleep 0.5
done

npx tsx src/server/db/migrate.ts
npx vitest run --config vitest.integration.config.ts "$@"

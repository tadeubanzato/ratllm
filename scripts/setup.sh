#!/usr/bin/env bash
# One-command local setup: generate a private .env and bring up the Docker stack.
#
# Usage: ./scripts/setup.sh
#
# Safe to re-run: it never overwrites an existing .env, and `docker compose up`
# is idempotent. It also refuses the one combination that silently breaks the app: a
# surviving database volume with no .env (a freshly generated password would not match
# the data already on disk, and the web app and worker would restart-loop on auth errors).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker/docker-compose.yml"
# Declared `external: true` in the compose file (so Compose stops warning about ownership), which means Compose never creates it.
DB_VOLUME="ratllm_curator-db-data"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. Preconditions -------------------------------------------------------

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop or Docker Engine first: https://docs.docker.com/get-docker/"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Docker Compose is not available (neither 'docker compose' nor 'docker-compose'). Install/update Docker Desktop or the compose-plugin."
fi

docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker and re-run this script."

rand_hex() {
  # $1 = number of random bytes (hex output is 2x as long)
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

portable_sed_i() {
  # BSD sed (macOS) and GNU sed (Linux) both accept -i.bak, then we drop the backup.
  sed -i.bak -e "$1" "$2" && rm -f "$2.bak"
}

# --- 2. Database volume ------------------------------------------------------

if docker volume inspect "$DB_VOLUME" >/dev/null 2>&1; then
  volume_exists=true
else
  volume_exists=false
fi

if [ ! -f .env ] && [ "$volume_exists" = true ]; then
  die "The database volume '$DB_VOLUME' already exists, but there is no .env. A new .env would generate a new database password that does not match the data already in that volume, and the app would fail to connect.
       Restore your original .env, or - ONLY if that data is disposable - remove the volume first:  docker volume rm $DB_VOLUME"
fi

if [ "$volume_exists" = false ]; then
  log "Creating the database volume '$DB_VOLUME' (the compose file expects it to exist)."
  docker volume create "$DB_VOLUME" >/dev/null
fi

# --- 3. Generate .env with unique secrets -----------------------------------

if [ -f .env ]; then
  log ".env already exists — leaving it untouched."
else
  [ -f .env.example ] || die ".env.example is missing; cannot bootstrap .env."
  log "Creating .env from .env.example with freshly generated secrets."
  cp .env.example .env
  chmod 600 .env

  POSTGRES_PASSWORD="$(rand_hex 20)"
  CREDENTIAL_ENCRYPTION_KEY="$(rand_hex 32)"
  INTERNAL_API_SECRET="$(rand_hex 24)"

  portable_sed_i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${POSTGRES_PASSWORD}#" .env
  portable_sed_i "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://curator:${POSTGRES_PASSWORD}@curator-db:5432/curator#" .env
  portable_sed_i "s#^CREDENTIAL_ENCRYPTION_KEY=.*#CREDENTIAL_ENCRYPTION_KEY=${CREDENTIAL_ENCRYPTION_KEY}#" .env
  portable_sed_i "s#^INTERNAL_API_SECRET=.*#INTERNAL_API_SECRET=${INTERNAL_API_SECRET}#" .env

  log "Generated unique POSTGRES_PASSWORD, CREDENTIAL_ENCRYPTION_KEY, and INTERNAL_API_SECRET."
  warn "Edit .env to set LITELLM_BASE_URL / LITELLM_MASTER_KEY and any provider API keys (OPENROUTER_API_KEY, GROQ_API_KEY, ...) before using those integrations."
  warn ".env contains secrets — it is gitignored by default. Never commit it."
fi

# --- 4. Build and start the stack -------------------------------------------

log "Building and starting the Docker stack ($COMPOSE_FILE)..."
$COMPOSE -f "$COMPOSE_FILE" up -d --build

# --- 5. Wait for readiness ---------------------------------------------------

CURATOR_PORT="$(grep -E '^CURATOR_PORT=' .env | tail -1 | cut -d= -f2- || true)"
CURATOR_PORT="${CURATOR_PORT:-9090}"
URL="http://localhost:${CURATOR_PORT}/api/ready"

if command -v curl >/dev/null 2>&1; then
  log "Waiting for the app to become ready at ${URL} ..."
  ready=false
  for _ in $(seq 1 30); do
    if curl -fsS "$URL" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 2
  done
  if [ "$ready" = true ]; then
    log "Ready! Open http://localhost:${CURATOR_PORT} in your browser."
    log "A running page is not the same as a working system. Check what still needs attention with:  curl -s http://localhost:${CURATOR_PORT}/api/status"
    log "(A fresh install reports 'degraded' until LiteLLM is configured and the first discovery and health checks have run - that is expected.)"
  else
    warn "Still not ready after 60s."
    web_log="$($COMPOSE -f "$COMPOSE_FILE" logs --tail 40 curator-web 2>&1 || true)"
    if printf '%s' "$web_log" | grep -qi 'password authentication failed'; then
      warn "The app cannot log in to the database: the password in .env does not match the one the database volume was created with."
      warn "Restore the original .env, or - only if that data is disposable - run:  $COMPOSE -f $COMPOSE_FILE down && docker volume rm $DB_VOLUME  and re-run this script."
    else
      warn "Last lines of the web log:"
      printf '%s\n' "$web_log" | tail -n 15
    fi
    warn "Full logs: $COMPOSE -f $COMPOSE_FILE logs -f curator-web curator-worker"
    exit 1
  fi
else
  log "docker compose is up. Open http://localhost:${CURATOR_PORT} once the containers report healthy."
fi

log "Useful commands:"
echo "  $COMPOSE -f $COMPOSE_FILE ps"
echo "  $COMPOSE -f $COMPOSE_FILE logs -f curator-web"
echo "  $COMPOSE -f $COMPOSE_FILE down"

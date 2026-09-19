#!/usr/bin/env bash
# Renders every supported Docker Compose topology and checks what each one actually contains, so a broken overlay is caught here
# rather than on a server. Needs the Docker CLI with the compose plugin; touches no containers or volumes.
#
#   ./scripts/check-compose.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || { echo "docker compose is not available; skipping" >&2; exit 0; }

# The compose file reads ../.env; render against the example values when there is no real one, and never leave a stand-in behind.
created_env=false
if [ ! -f .env ]; then cp .env.example .env; created_env=true; fi
trap '[ "$created_env" = true ] && rm -f .env' EXIT

BASE=(-f docker/docker-compose.yml)
LAN=(-f docker/docker-compose.lan.yml)
REMOTE=(-f docker/docker-compose.remote.yml)
fail=0
check() { printf '  %-52s' "$1"; if eval "$2"; then echo ok; else echo FAIL; fail=1; fi; }
services() { docker compose "$@" config --services | sort | tr '\n' ' '; }
rendered() { docker compose "$@" config; }

echo "server (default)"
check "renders"                                              "docker compose ${BASE[*]} config -q"
check "runs web + worker + database"                         "[ \"\$(services ${BASE[*]})\" = 'curator-db curator-web curator-worker ' ]"
check "web and worker are in server mode"                    "[ \"\$(rendered ${BASE[*]} | grep -c 'RATLLM_DEPLOYMENT_MODE: server')\" = 2 ]"
check "the external database volume is declared"             "rendered ${BASE[*]} | grep -q 'name: ratllm_curator-db-data'"

echo "server + LAN database access"
check "renders"                                              "docker compose ${BASE[*]} ${LAN[*]} config -q"
check "still web + worker + database"                        "[ \"\$(services ${BASE[*]} ${LAN[*]})\" = 'curator-db curator-web curator-worker ' ]"
check "publishes the database port"                          "rendered ${BASE[*]} ${LAN[*]} | grep -q 'published: \"5432\"'"

echo "workstation, remote mode (server owns the database and scheduling)"
check "renders"                                              "docker compose ${BASE[*]} ${REMOTE[*]} config -q"
check "runs ONLY the web app (no local database, no worker)" "[ \"\$(services ${BASE[*]} ${REMOTE[*]})\" = 'curator-web ' ]"
check "is in workstation-remote mode"                        "rendered ${BASE[*]} ${REMOTE[*]} | grep -q 'RATLLM_DEPLOYMENT_MODE: workstation-remote'"
# The image's default start command migrates and seeds; the overlay must replace it with a plain `pnpm start`.
check "starts with a plain 'pnpm start' (no migrate/seed)"   "rendered ${BASE[*]} ${REMOTE[*]} | grep -A3 'command:' | grep -q -- '- start'"

[ "$fail" = 0 ] && echo "all topologies OK" || { echo "compose check FAILED" >&2; exit 1; }

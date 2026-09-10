# Production deployment

RATLLM (Okame Model Curator) runs as a Next.js production container with a dedicated PostgreSQL database and its own scheduling worker. LiteLLM runs separately and is configured through `.env`.

## Quick start

```bash
./scripts/setup.sh
```

This bootstraps `.env` with generated secrets (if it doesn't already exist)
and starts the stack. To do it by hand instead:

```bash
cp .env.example .env
# set POSTGRES_PASSWORD, DATABASE_URL, LITELLM_BASE_URL and LITELLM_MASTER_KEY
docker compose -f docker/docker-compose.yml up -d --build
curl http://localhost:9090/api/ready
```

The default host port is `9090`; set `CURATOR_PORT` to change it.

## Use the server database from a workstation

The shared database lives on `192.168.5.48`. On that Linux server, keep
`DATABASE_URL` pointing to `curator-db:5432` and publish PostgreSQL on the LAN:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.lan.yml up -d curator-db
```

Allow TCP port 5432 from the workstation in the server firewall if needed.
On the workstation, set `.env` `DATABASE_URL` to
`postgresql://USER:PASSWORD@192.168.5.48:5432/DATABASE`, using the server's
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` values. URL-encode
special characters in the username and password. Then run:

```bash
docker compose -f docker/docker-compose.yml stop curator-worker curator-db
docker compose -f docker/docker-compose.yml -f docker/docker-compose.remote.yml up -d --build curator-web
curl http://localhost:9090/api/ready
```

Remote mode starts only the web app, without migrations or seed writes. The
server retains responsibility for schema upgrades and background jobs. The
local database volume is preserved. For development, `npm run dev` uses the
same `.env` database URL. LAN access or a VPN route to `192.168.5.48` is required.
You can also use the server app directly at `http://192.168.5.48:9090`.

## Required environment

Set `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`, `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, and `INTERNAL_API_SECRET`. `CURATOR_PUBLIC_URL` remains a compatibility fallback for public-ingress deployments.

Never commit `.env` or place real provider keys in examples. Provider credentials entered in the UI are encrypted and never returned to the browser.

## Operations

```bash
docker compose -f docker/docker-compose.yml logs -f curator-web
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml down
```

The containers are named `ratllm-web` and `ratllm-db`. The Compose project is `ratllm`. PostgreSQL data is persisted in the existing `okame-model-curator_curator-db-data` volume so renaming does not lose inventory. Do not use `down --volumes` unless that data is intentionally being destroyed.

Scheduling (model discovery, health monitoring, rate-limit learning, and the rest of automation) runs entirely inside the `curator-worker` container against the Curator database — there is no external orchestrator dependency. Configure schedules from the Automation tab in Settings.

# Production deployment

RATLLM (Okame Model Curator) runs as a Next.js production container with a dedicated PostgreSQL database. LiteLLM and n8n run separately and are configured through `.env`.

## Quick start

```bash
cp .env.example .env
# set POSTGRES_PASSWORD, DATABASE_URL, LITELLM_BASE_URL and LITELLM_MASTER_KEY
docker compose -f docker/docker-compose.yml up -d --build
curl http://localhost:9090/api/ready
```

The default host port is `9090`; set `CURATOR_PORT` to change it.

## Required environment

Set `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`, `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, and optionally `N8N_BASE_URL`, `N8N_API_KEY`, and `CURATOR_PUBLIC_URL`.

Never commit `.env` or place real provider keys in examples. Provider credentials entered in the UI are encrypted and never returned to the browser.

## Operations

```bash
docker compose -f docker/docker-compose.yml logs -f curator-web
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml down
```

The containers are named `ratllm-web` and `ratllm-db`. The Compose project is `ratllm`. PostgreSQL data is persisted in the existing `okame-model-curator_curator-db-data` volume so renaming does not lose inventory. Do not use `down --volumes` unless that data is intentionally being destroyed.

After configuring n8n, open the Curator n8n page and use **Create workflows**. The daily curation workflow is activated by that action; other workflows remain inactive until their endpoints are enabled.

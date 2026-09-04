# Okame Model Curator

Okame is a self-hosted control plane for the model deployments behind stable LiteLLM aliases. The Curator database is authoritative; LiteLLM is an external deployment target, and unmanaged LiteLLM deployments are always preserved.

Milestone 1 provides a production-built Next.js control plane, PostgreSQL persistence, LiteLLM inventory synchronization, managed/unmanaged classification, eight `smart-*` lanes, model detail views, health/readiness endpoints, and persisted smoke tests.

## Quick start

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, DATABASE_URL, LITELLM_BASE_URL, and LITELLM_MASTER_KEY.
docker compose -f docker/docker-compose.yml up --build
```

Open `http://localhost:9090`. The container applies versioned Drizzle migrations and idempotent seed data before starting.

To inspect the interface without PostgreSQL or provider credentials:

```bash
DEMO_MODE=true pnpm dev
```

Demo data is isolated in `src/server/demo-data.ts`; production pages never silently fall back to it.

## Local development

Node.js 24 and pnpm 10 are recommended.

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Quality checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Connecting LiteLLM

Set `LITELLM_BASE_URL` and the server-only `LITELLM_MASTER_KEY`, then open **LiteLLM** and select **Sync inventory**. Okame reads `/v1/model/info` through a version-tolerant adapter and stores a sanitized inventory. Select a model to run a chat-completions smoke test.

Milestone 1 does not mutate LiteLLM deployments. Deployment changes will only be enabled with change plans, safety validation, snapshots, smoke verification, and idempotent rollback.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Curator-owned PostgreSQL connection |
| `LITELLM_BASE_URL` | LiteLLM Proxy base URL |
| `LITELLM_MASTER_KEY` | Server-only LiteLLM administrative key |
| `N8N_BASE_URL` | Optional n8n URL |
| `INTERNAL_API_SECRET` | Future n8n-to-Curator authentication secret |
| `ADMIN_TOKEN` | Optional bearer protection for non-health routes |
| `DEMO_MODE` | Enables isolated development data |

See [architecture](docs/ARCHITECTURE.md), [database](docs/DATABASE.md), [LiteLLM](docs/LITELLM.md), [deployment](docs/DEPLOYMENT.md), and [security](docs/SECURITY.md). The production stack is the Next.js/PostgreSQL application under `src/` and `docker/`.

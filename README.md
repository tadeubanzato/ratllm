# RatLLM

RatLLM is a self-hosted, open-source control plane for the model deployments behind stable LiteLLM aliases. You bring your own model providers and your own LiteLLM proxy; RatLLM tracks what's actually deployed, tests it on a schedule, learns its real rate limits, and keeps LiteLLM's routing in sync — without ever touching a LiteLLM deployment it didn't create.

This is a personal, educational, non-commercial project — a place to evaluate model providers of your choosing side by side. See [About](#about--license) below for the full picture, or open the **About** page in the running app.

The full discover → verify → promote → monitor → remove automation loop, its status-label taxonomy, and its schedule are documented end to end in [`docs/FREE-MODEL-LIFECYCLE.md`](docs/FREE-MODEL-LIFECYCLE.md) — read that before changing anything under `src/server/discovery`, `src/server/health`, `src/server/lanes`, or `src/server/automation`.

## Contents

- [Installation](#installation)
- [Setting up LiteLLM](#setting-up-litellm)
- [Pages](#pages)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [About & license](#about--license)

## Installation

Requires [Docker](https://docs.docker.com/get-docker/) (with Compose) installed and running.

```bash
git clone <this-repo-url>
cd ratllm
./scripts/setup.sh
```

This generates a private `.env` (git-ignored, never committed) with unique `POSTGRES_PASSWORD`, `CREDENTIAL_ENCRYPTION_KEY`, and `INTERNAL_API_SECRET` values, then builds and starts the full stack (app, worker, PostgreSQL — Postgres is created and migrated automatically, no manual database step needed). The script is safe to re-run; it never overwrites an existing `.env`. Open `http://localhost:9090` once it reports ready.

To connect LiteLLM or a model provider, edit `.env` and set `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY`, and any provider API keys, then re-run the script (or `docker compose -f docker/docker-compose.yml up -d --build`) to pick them up.

Prefer to do it by hand instead?

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, DATABASE_URL, LITELLM_BASE_URL, and LITELLM_MASTER_KEY.
docker compose -f docker/docker-compose.yml up --build
```

To inspect the interface without PostgreSQL or provider credentials:

```bash
DEMO_MODE=true pnpm dev
```

Demo data is isolated in `src/server/demo-data.ts`; production pages never silently fall back to it.

### Check that it is actually working

A running page is not the same as a working system: `/api/health` only says the web process is alive and the worker is beating. After setup (and any time you wonder), check:

```bash
curl -s http://localhost:9090/api/status
```

It returns `healthy`, or `degraded` with a plain-language reason for each problem: no worker running, LiteLLM unreachable, discovery or health checks gone stale, jobs that failed in the last 24 hours, invalid provider credentials, and live models that are not serving. The same reasons appear at the top of the Overview page. A freshly installed system reports `degraded` until the first discovery and health checks have run — that is correct, not a bug.

## Setting up LiteLLM

RatLLM does not run inference itself — it manages deployments on a [LiteLLM](https://github.com/BerriAI/litellm) proxy that you run separately. If you don't already have one, a minimal self-hosted LiteLLM proxy looks like this:

`litellm-config.yaml`:
```yaml
model_list: []          # RatLLM adds deployments here for you; start empty
general_settings:
  master_key: sk-choose-a-strong-master-key
  store_model_in_db: true   # required for RatLLM's lane fallback-chain management
```

`docker-compose.yml` (a separate stack from RatLLM's own):
```yaml
services:
  litellm-db:
    image: postgres:17-alpine
    environment: { POSTGRES_DB: litellm, POSTGRES_USER: litellm, POSTGRES_PASSWORD: change-me }
    volumes: [litellm-db-data:/var/lib/postgresql/data]
  litellm:
    image: ghcr.io/berriai/litellm:main-stable
    ports: ["4000:4000"]
    environment:
      DATABASE_URL: postgresql://litellm:change-me@litellm-db:5432/litellm
      STORE_MODEL_IN_DB: "True"
    volumes: ["./litellm-config.yaml:/app/config.yaml"]
    command: ["--config", "/app/config.yaml"]
    depends_on: [litellm-db]
volumes:
  litellm-db-data:
```

Bring it up (`docker compose up -d`), then point RatLLM's `.env` at it:

```bash
LITELLM_BASE_URL=http://<host-or-container-name>:4000
LITELLM_MASTER_KEY=sk-choose-a-strong-master-key
```

If both stacks run on the same Docker host, put them on a shared external network so RatLLM can reach LiteLLM by container name; otherwise use the host's LAN address. Once `.env` is set, open **LiteLLM** in RatLLM and select **Sync inventory** — see [Pages](#pages) below and `docs/LITELLM.md` for what happens next. LiteLLM's own docs cover authentication, provider configuration, and production hardening in far more depth than is reproduced here.

## Pages

### Overview
![Overview](docs/screenshots/overview.png)

The dashboard: provider, lane, and deployment counts, health at a glance, recent scheduled activity, and anything currently flagged for attention.

### Providers
![Providers](docs/screenshots/providers.png)

Every provider you've configured, its credential and operational status, and a per-provider **Availability** history — each provider shows its own uptime, not one number shared across the whole page.

### Discovered Models
![Discovered Models](docs/screenshots/models.png)

Models found on a provider's catalog before they're added to LiteLLM. **Add to LiteLLM** opens a lane picker — the model's capabilities pre-select the `smart-*` groups that fit — and adding it registers a router deployment per lane, a `lane_assignments` record, and refreshes the cross-lane fallback chains.

### Lanes
![Lanes](docs/screenshots/lanes.png)

The `smart-*` LiteLLM model groups (general, coding, agent, deep reasoning, long-context, vision, summary, speech) and which deployments currently back each one. The `LANE_RECONCILE` automation re-adds any missing lane member and re-pushes fallback chains on a schedule.

### Benchmarks
![Benchmarks](docs/screenshots/benchmarks.png)

Operational results from the automatic health probe for every deployment: pass/fail, latency, success rate over its last 20 smoke tests, p50/p95 latency percentiles, and average time-to-first-token.

### Runs
![Runs](docs/screenshots/runs.png)

The execution log for every scheduled and manually triggered job — discovery, credential verification, health checks, rate-limit learning, lane reconciliation, and maintenance.

### LiteLLM
![LiteLLM](docs/screenshots/litellm.png)

The connection to your LiteLLM proxy: live deployment inventory sorted by real check availability, local (MLX) deployments called out, and which deployments RatLLM manages versus which it leaves alone. Health checks run automatically on a schedule — no manual per-deployment test button needed. Unmanaged deployments never enter a mutation code path.

### Settings
![Settings](docs/screenshots/settings.png)

Control plane status, the LiteLLM connection (with a one-click **Auto setup** for lanes and fallbacks, plus auto-add/auto-remove toggles), per-provider settings, automation schedules (including `PROVIDER_VERIFICATION`, which re-checks every credentialed provider on a schedule instead of only on manual click), free model sources, and safety controls.

### About
![About](docs/screenshots/about.png)

The in-app version of the [About & license](#about--license) section below.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Curator-owned PostgreSQL connection |
| `LITELLM_BASE_URL` | LiteLLM Proxy base URL |
| `LITELLM_MASTER_KEY` | Server-only LiteLLM administrative key |
| `INTERNAL_API_SECRET` | Authenticates internal automation endpoints |
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts provider credentials at rest |
| `CREDENTIAL_ENCRYPTION_KEYS` / `CREDENTIAL_ENCRYPTION_KEY_ID` | Optional keyring for rotating the key above (see `docs/SECURITY.md`) |
| `DEMO_MODE` | Enables isolated development data |

See [architecture](docs/ARCHITECTURE.md), [database](docs/DATABASE.md), [LiteLLM](docs/LITELLM.md), [deployment](docs/DEPLOYMENT.md), [rate-limit learning](docs/RATE-LIMIT-LEARNING.md), and [security](docs/SECURITY.md) for deeper detail than this file covers. The production stack is the Next.js/PostgreSQL application under `src/` and `docker/`.

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

## About & license

RatLLM is released under the [MIT License](LICENSE) as a personal engineering and study project — a tool for understanding model-routing infrastructure by adding your own providers and comparing their real-world performance, not a commercial product or paid service. There is no monetization, subscription, or resale associated with this software, and it does not select, rank, or restrict providers by any commercial criteria.

It is provided **"AS IS"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. The author accepts no liability for any claim, damages, or other liability arising from its use.

Using RatLLM means supplying your own credentials for third-party providers. You are solely responsible for complying with each provider's own terms of service and usage policies, and for any costs you incur — RatLLM stores and routes only the credentials you provide, and does not grant you access to any provider on your behalf. RatLLM is not affiliated with, endorsed by, or sponsored by LiteLLM or any model provider it can connect to; all trademarks belong to their respective owners and are used only to identify the services this software can integrate with.

This is a plain-language summary, not legal advice. If you plan to use RatLLM beyond personal, non-commercial evaluation, consult your own counsel.

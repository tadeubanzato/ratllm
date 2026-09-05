# Deployment

Compose starts `curator-web`, `curator-worker`, and persistent PostgreSQL 17. LiteLLM remains external. The Node Alpine image supports standard AMD64/ARM64 Docker hosts.

Copy `.env.example` to `.env`, generate strong values, and ensure LiteLLM is reachable from the Compose network. `/api/health` checks the app; `/api/ready` additionally checks PostgreSQL. The web container applies migrations and idempotent seed data before start.

Back up the `curator-db-data` volume before upgrades.

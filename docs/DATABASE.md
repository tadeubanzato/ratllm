# Database

PostgreSQL is authoritative and does not share LiteLLM tables. Versioned migrations are in `drizzle/`.

Milestone tables cover providers and credential references, canonical models and provider deployments, capabilities, rate-limit profiles, lanes and assignments, synchronization runs, smoke tests, settings, audit events, and mutation leases. UUIDs, timezone-aware timestamps, relational constraints, and targeted indexes are used throughout.

Core fields remain columns; raw LiteLLM metadata is recursively sanitized and retained in JSONB only for diagnostics. Credential records contain environment variable names, never values.

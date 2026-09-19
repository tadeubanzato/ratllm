# Database

PostgreSQL is authoritative and does not share LiteLLM tables. Versioned migrations are in `drizzle/`.

Milestone tables cover providers and credential references, canonical models and provider deployments, capabilities, rate-limit profiles, lanes and assignments, synchronization runs, smoke tests, settings, audit events, and mutation leases. UUIDs, timezone-aware timestamps, relational constraints, and targeted indexes are used throughout.

Core fields remain columns; raw LiteLLM metadata is recursively sanitized and retained in JSONB only for diagnostics. Credential records hold the environment variable name and the value **encrypted at rest** (`encrypted_value`, AES-256-GCM, with a key id so the encryption key can be rotated — see `docs/SECURITY.md`); `value_hint` is only a neutral label ("Configured"), never any part of the key. The plaintext is never stored, logged, or returned by any API or page.

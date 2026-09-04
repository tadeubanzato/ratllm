# Database migration safety

RATLLM uses PostgreSQL as the source of truth for live providers, credentials,
inventory, runs, and operator configuration. Migrations are additive and are
applied through Drizzle; they must never reset, truncate, or recreate the
database.

## Backup before applying a release

From the host running the Compose stack, create a timestamped logical backup:

```sh
docker exec ratllm-db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > ratllm-$(date +%Y%m%d-%H%M%S).dump
```

Validate that the file is non-empty and retain it outside the Docker volume.
To inspect a backup without restoring it:

```sh
pg_restore --list ratllm-YYYYMMDD-HHMMSS.dump
```

## Applying migrations

1. Build the new images.
2. Ensure `curator-db` is healthy.
3. Apply `pnpm db:migrate` once from the web or worker image.
4. Confirm migration records and application readiness.
5. Do not run `dropdb`, `createdb`, `drizzle-kit push`, schema resets, or
   destructive test commands against the production database.

Compose uses the explicitly named `okame-model-curator_curator-db-data`
volume, preserving the existing data across service rebuilds and restarts.

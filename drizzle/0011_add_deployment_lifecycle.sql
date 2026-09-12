CREATE TYPE "public"."deployment_lifecycle" AS ENUM('ACTIVE', 'DEACTIVATED', 'REMOVED');--> statement-breakpoint
ALTER TABLE "model_deployments" ADD COLUMN "lifecycle" "deployment_lifecycle" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
-- Backfill from the ad hoc raw_metadata.lifecycle string this column replaces, so rows already deactivated/removed
-- (via the manual lifecycle route, auto-remove, or a sync that already flagged them) don't silently reset to ACTIVE.
UPDATE "model_deployments" SET "lifecycle" = 'DEACTIVATED' WHERE "raw_metadata"->>'lifecycle' = 'DEACTIVATED';--> statement-breakpoint
UPDATE "model_deployments" SET "lifecycle" = 'REMOVED' WHERE "raw_metadata"->>'lifecycle' IN ('REMOVED', 'AUTO_REMOVED');--> statement-breakpoint
-- Also catch deployments the sync job already found missing from LiteLLM's own inventory (health flipped to
-- UNAVAILABLE at src/server/litellm/sync.ts's reconciliation step) that never got a raw_metadata.lifecycle tag at
-- all, since that write path predates this column and only ever set health.
UPDATE "model_deployments" SET "lifecycle" = 'REMOVED' WHERE "lifecycle" = 'ACTIVE' AND "litellm_deployment_id" IS NOT NULL AND "health" = 'UNAVAILABLE';
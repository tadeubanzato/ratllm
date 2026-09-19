-- Data hygiene and the first database-enforced invariants (findings.md §13).
--
-- Part 1 repairs the rows a read-only audit of production found. Part 2 adds CHECK constraints for the rules the application
-- already relies on, so bad data can no longer be written by any code path (or by a future service in another language).
--
-- Every constraint is added NOT VALID: it is enforced for new and changed rows without scanning existing ones, so an unexpected
-- old row can never make this migration fail and stop the web container from starting. Once the cleanup below has run, they can
-- be validated at leisure with `ALTER TABLE ... VALIDATE CONSTRAINT <name>`.
--
-- What the audit found (production, 2026-09-19):
--   97 candidates with last_seen_at before first_seen_at — by at most 238 microseconds: the app clock vs the database default.
--    2 smoke tests storing http_status 0 ("no HTTP response") instead of NULL.
--  190 candidates with a context window / max output of 0 or less: sources report 0 for "unknown".
--   Everything else audited was already clean.

-- ---------------------------------------------------------------- Part 1: repair
UPDATE "model_candidates" SET "first_seen_at" = "last_seen_at" WHERE "last_seen_at" < "first_seen_at";
--> statement-breakpoint
UPDATE "smoke_tests" SET "http_status" = NULL WHERE "http_status" IS NOT NULL AND ("http_status" < 100 OR "http_status" > 599);
--> statement-breakpoint
UPDATE "candidate_checks" SET "http_status" = NULL WHERE "http_status" IS NOT NULL AND ("http_status" < 100 OR "http_status" > 599);
--> statement-breakpoint
UPDATE "model_candidates" SET "context_window" = NULL WHERE "context_window" <= 0;
--> statement-breakpoint
UPDATE "model_candidates" SET "max_output_tokens" = NULL WHERE "max_output_tokens" <= 0;
--> statement-breakpoint
-- ---------------------------------------------------------------- Part 2: constraints
-- One second of tolerance: the two timestamps can come from different clocks (application vs database host).
ALTER TABLE "model_candidates" ADD CONSTRAINT "model_candidates_seen_order_chk" CHECK ("last_seen_at" >= "first_seen_at" - interval '1 second') NOT VALID;
--> statement-breakpoint
ALTER TABLE "model_candidates" ADD CONSTRAINT "model_candidates_limits_chk" CHECK (("context_window" IS NULL OR "context_window" > 0) AND ("max_output_tokens" IS NULL OR "max_output_tokens" > 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "canonical_models" ADD CONSTRAINT "canonical_models_limits_chk" CHECK (("context_window" IS NULL OR "context_window" > 0) AND ("max_output_tokens" IS NULL OR "max_output_tokens" > 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "smoke_tests" ADD CONSTRAINT "smoke_tests_http_status_chk" CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599) NOT VALID;
--> statement-breakpoint
ALTER TABLE "smoke_tests" ADD CONSTRAINT "smoke_tests_timings_chk" CHECK (("latency_ms" IS NULL OR "latency_ms" >= 0) AND ("first_token_ms" IS NULL OR "first_token_ms" >= 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "candidate_checks" ADD CONSTRAINT "candidate_checks_http_status_chk" CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599) NOT VALID;
--> statement-breakpoint
ALTER TABLE "rate_limit_profiles" ADD CONSTRAINT "rate_limit_profiles_values_chk" CHECK (("rpm_limit" IS NULL OR "rpm_limit" > 0) AND ("tpm_limit" IS NULL OR "tpm_limit" > 0) AND ("manual_rpm" IS NULL OR "manual_rpm" > 0) AND ("manual_tpm" IS NULL OR "manual_tpm" > 0) AND "sample_count" >= 0 AND "confidence_score" BETWEEN 0 AND 1) NOT VALID;
--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_size_chk" CHECK ("minimum_healthy" >= 0 AND "maximum_deployments" >= 0 AND "minimum_healthy" <= "maximum_deployments") NOT VALID;
--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_time_order_chk" CHECK ("finished_at" IS NULL OR "started_at" IS NULL OR "finished_at" >= "started_at") NOT VALID;
--> statement-breakpoint
ALTER TABLE "model_sources" ADD CONSTRAINT "model_sources_count_chk" CHECK ("discovered_model_count" >= 0) NOT VALID;
--> statement-breakpoint
-- The credentials API already enforces this pattern; the database now agrees.
ALTER TABLE "provider_credential_references" ADD CONSTRAINT "provider_credentials_env_chk" CHECK ("environment_variable" ~ '^[A-Z][A-Z0-9_]*$') NOT VALID;
--> statement-breakpoint
-- A live deployment is one the router knows by id; a managed one has a recorded manager.
ALTER TABLE "model_deployments" ADD CONSTRAINT "model_deployments_active_has_id_chk" CHECK ("lifecycle" <> 'ACTIVE' OR "litellm_deployment_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "model_deployments" ADD CONSTRAINT "model_deployments_managed_has_owner_chk" CHECK (NOT "managed" OR ("managed_by" IS NOT NULL AND "managed_by" <> '')) NOT VALID;

CREATE TABLE "provider_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"source" text NOT NULL,
	"free_type" "free_type" DEFAULT 'UNKNOWN' NOT NULL,
	"free_tier_text" text,
	"rate_limits_text" text,
	"notes" text,
	"expires_at" text,
	"card_required" boolean,
	"phone_required" boolean,
	"commercial_ok" boolean,
	"openai_base_url" text,
	"docs_url" text,
	"source_verified" boolean,
	"source_last_verified" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "model_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "last_check_status" text;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "last_passed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "consecutive_passes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "ever_failed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "check_blocker" text;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "added_to_litellm_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD COLUMN "added_by" text;--> statement-breakpoint
ALTER TABLE "model_sources" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "model_sources" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "origin" text DEFAULT 'CATALOG' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_offers" ADD CONSTRAINT "provider_offers_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_offer_uidx" ON "provider_offers" USING btree ("provider_id","source");--> statement-breakpoint
CREATE INDEX "candidate_provider_key_idx" ON "model_candidates" USING btree ("provider_id","model_key");--> statement-breakpoint
CREATE INDEX "candidate_model_key_idx" ON "model_candidates" USING btree ("model_key");--> statement-breakpoint
CREATE INDEX "candidate_next_check_idx" ON "model_candidates" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "candidate_rank_idx" ON "model_candidates" USING btree ("consecutive_passes","last_passed_at");--> statement-breakpoint
CREATE INDEX "candidate_first_seen_idx" ON "model_candidates" USING btree ("first_seen_at");--> statement-breakpoint
-- ── Data migration ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. model_key: the same rule as bareModelKey() in src/server/discovery/model-key.ts. tests-integration/discovery-pipeline
--    checks this SQL against the TypeScript on every stored model_ref, so the two cannot drift apart.
UPDATE "model_candidates" SET "model_key" = lower(regexp_replace(
  CASE WHEN substring(btrim("model_ref") from '[^/]*$') ~ '[0-9]' AND length(substring(btrim("model_ref") from '[^/]*$')) >= 4
       THEN substring(btrim("model_ref") from '[^/]*$') ELSE btrim("model_ref") END,
  '[^a-zA-Z0-9]+', '', 'g'));
--> statement-breakpoint
-- 2. Direct-check history holds real provider calls only (invariant I6). Rows recorded for "no call could be made" are
--    removed; the reason lives on the candidate as check_blocker instead.
UPDATE "model_candidates" SET "check_blocker" = CASE "evidence"->>'lastStatus'
  WHEN 'provider_unresolved' THEN 'PROVIDER_UNRESOLVED'
  WHEN 'provider_not_configured' THEN 'NO_ENDPOINT'
  WHEN 'credential_missing' THEN 'CREDENTIAL_MISSING'
  WHEN 'credential_unverified' THEN 'CREDENTIAL_UNVERIFIED'
  ELSE NULL END;
--> statement-breakpoint
DELETE FROM "candidate_checks" WHERE "status" IN ('provider_unresolved','provider_not_configured','credential_missing','credential_unverified');
--> statement-breakpoint
-- 3. State derived from what is left: the latest real check, the latest pass, and the current streak.
UPDATE "model_candidates" m SET "last_check_status" = l."status", "last_checked_at" = l."created_at"
FROM (SELECT DISTINCT ON ("candidate_id") "candidate_id", "status", "created_at" FROM "candidate_checks" ORDER BY "candidate_id", "created_at" DESC) l
WHERE l."candidate_id" = m."id";
--> statement-breakpoint
UPDATE "model_candidates" m SET "last_passed_at" = p."at"
FROM (SELECT "candidate_id", max("created_at") AS "at" FROM "candidate_checks" WHERE "status" = 'available' GROUP BY "candidate_id") p
WHERE p."candidate_id" = m."id";
--> statement-breakpoint
UPDATE "model_candidates" m SET "consecutive_passes" = COALESCE(f."rn" - 1, t."n")
FROM (SELECT "candidate_id", count(*) AS "n" FROM "candidate_checks" GROUP BY "candidate_id") t
LEFT JOIN (
  SELECT "candidate_id", min("rn") AS "rn" FROM (
    SELECT "candidate_id", "status", row_number() OVER (PARTITION BY "candidate_id" ORDER BY "created_at" DESC) AS "rn" FROM "candidate_checks"
  ) r WHERE r."status" <> 'available' GROUP BY "candidate_id"
) f ON f."candidate_id" = t."candidate_id"
WHERE m."id" = t."candidate_id";
--> statement-breakpoint
UPDATE "model_candidates" SET "ever_failed" = EXISTS (SELECT 1 FROM "candidate_checks" c WHERE c."candidate_id" = "model_candidates"."id" AND c."status" <> 'available');
--> statement-breakpoint
-- The recheck schedule carries over from the old evidence blob (guarded: a malformed value must not fail the migration).
UPDATE "model_candidates" SET "next_check_at" = ("evidence"->>'nextCheckAt')::timestamptz
WHERE "evidence"->>'nextCheckAt' ~ '^\d{4}-\d{2}-\d{2}T';
--> statement-breakpoint
-- 4. Scrape-era leftovers. These sources used to scrape a marketing page and now read the provider's own API, whose ids do not
--    match the scraped tokens, so nothing can ever refresh such a row again. Rows that have no provider, never passed a check and
--    were never in LiteLLM are junk from the old parser and are removed once here; anything with a provider, a pass or a
--    deployment is kept, and everything else is handled by the normal retirement rule after a week.
DELETE FROM "model_candidates" WHERE "provider_id" IS NULL AND "last_passed_at" IS NULL AND "added_to_litellm_at" IS NULL
  AND "source" IN ('groq','nvidia_nim','alibaba','zai','kilo','modelscope','nebius','baseten','pollinations','fireworks_ai','together_ai','chutes_ai');

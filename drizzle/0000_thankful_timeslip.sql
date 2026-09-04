CREATE TYPE "public"."adapter_capability" AS ENUM('AUTOMATED', 'PARTIAL', 'MANUAL', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."deployment_health" AS ENUM('HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'UNAVAILABLE', 'AUTH_ERROR', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."free_type" AS ENUM('PERMANENT_FREE', 'RECURRING_DAILY', 'RECURRING_MONTHLY', 'FREE_TIER', 'TRIAL_CREDIT', 'PROMOTIONAL', 'UNKNOWN', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."limit_source" AS ENUM('DOCUMENTED', 'OBSERVED', 'ESTIMATED', 'MANUAL', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."model_lifecycle" AS ENUM('DISCOVERED', 'CANDIDATE', 'ACTIVE', 'DEGRADED', 'QUARANTINED', 'RETIRED', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('ACTIVE', 'DEGRADED', 'DISABLED', 'AUTH_FAILED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK');--> statement-breakpoint
CREATE TYPE "public"."smoke_status" AS ENUM('PENDING', 'PASSED', 'FAILED');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"family" text,
	"lifecycle" "model_lifecycle" DEFAULT 'DISCOVERED' NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_models_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "lane_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lane_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"score" double precision,
	"pinned" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_score" double precision DEFAULT 0 NOT NULL,
	"minimum_healthy" integer DEFAULT 2 NOT NULL,
	"maximum_deployments" integer DEFAULT 8 NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lanes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"supported" boolean NOT NULL,
	"confidence" "confidence" DEFAULT 'UNKNOWN' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_model_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"provider_model_id" text NOT NULL,
	"litellm_deployment_id" text,
	"litellm_model_name" text NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"managed_by" text,
	"curator_version" text,
	"health" "deployment_health" DEFAULT 'UNKNOWN' NOT NULL,
	"free_type" "free_type" DEFAULT 'UNKNOWN' NOT NULL,
	"score" double precision,
	"api_base" text,
	"raw_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credential_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"environment_variable" text NOT NULL,
	"last_validated_at" timestamp with time zone,
	"valid" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "provider_status" DEFAULT 'ACTIVE' NOT NULL,
	"adapter_key" text NOT NULL,
	"adapter_capability" "adapter_capability" DEFAULT 'MANUAL' NOT NULL,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_discovery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"rpm_limit" integer,
	"tpm_limit" integer,
	"rpm_source" "limit_source" DEFAULT 'UNKNOWN' NOT NULL,
	"tpm_source" "limit_source" DEFAULT 'UNKNOWN' NOT NULL,
	"observed_rpm" integer,
	"observed_tpm" integer,
	"safe_rpm" integer,
	"safe_tpm" integer,
	"confidence" "confidence" DEFAULT 'UNKNOWN' NOT NULL,
	"confidence_score" double precision DEFAULT 0 NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"manual_rpm" integer,
	"manual_tpm" integer,
	"last_probe_at" timestamp with time zone,
	"last_429_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_profiles_deployment_id_unique" UNIQUE("deployment_id")
);
--> statement-breakpoint
CREATE TABLE "smoke_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"deployment_id" uuid,
	"lane" text,
	"status" "smoke_status" DEFAULT 'PENDING' NOT NULL,
	"latency_ms" integer,
	"http_status" integer,
	"error_code" text,
	"error" text,
	"response_excerpt" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" "run_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text,
	"correlation_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lane_assignments" ADD CONSTRAINT "lane_assignments_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_assignments" ADD CONSTRAINT "lane_assignments_deployment_id_model_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."model_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_capabilities" ADD CONSTRAINT "model_capabilities_model_id_canonical_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."canonical_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_deployments" ADD CONSTRAINT "model_deployments_canonical_model_id_canonical_models_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."canonical_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_deployments" ADD CONSTRAINT "model_deployments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential_references" ADD CONSTRAINT "provider_credential_references_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_profiles" ADD CONSTRAINT "rate_limit_profiles_deployment_id_model_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."model_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smoke_tests" ADD CONSTRAINT "smoke_tests_run_id_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smoke_tests" ADD CONSTRAINT "smoke_tests_deployment_id_model_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."model_deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_deployment_uidx" ON "lane_assignments" USING btree ("lane_id","deployment_id");--> statement-breakpoint
CREATE INDEX "lane_priority_idx" ON "lane_assignments" USING btree ("lane_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "model_capability_uidx" ON "model_capabilities" USING btree ("model_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_identity_uidx" ON "model_deployments" USING btree ("litellm_model_name","provider_model_id","litellm_deployment_id");--> statement-breakpoint
CREATE INDEX "deployments_provider_idx" ON "model_deployments" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "deployments_managed_health_idx" ON "model_deployments" USING btree ("managed","health");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_provider_env_uidx" ON "provider_credential_references" USING btree ("provider_id","environment_variable");--> statement-breakpoint
CREATE INDEX "providers_status_idx" ON "providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "smoke_tests_created_idx" ON "smoke_tests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_runs_created_idx" ON "sync_runs" USING btree ("created_at");
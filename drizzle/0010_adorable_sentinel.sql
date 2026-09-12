ALTER TYPE "public"."free_type" ADD VALUE 'RECURRING_CREDIT' BEFORE 'FREE_TIER';--> statement-breakpoint
ALTER TYPE "public"."free_type" ADD VALUE 'TRIAL_QUOTA' BEFORE 'PROMOTIONAL';--> statement-breakpoint
ALTER TYPE "public"."free_type" ADD VALUE 'OPEN_WEIGHT_SELF_HOSTED' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."free_type" ADD VALUE 'PROVIDER_SPECIFIC_FREE' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TABLE "provider_credential_references" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;
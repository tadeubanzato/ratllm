ALTER TABLE "automation_jobs" ADD COLUMN "run_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_jobs" ADD COLUMN "requested_options" jsonb;
ALTER TABLE "automation_jobs" ADD COLUMN "custom_schedule" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_runs_type_created_idx" ON "sync_runs" USING btree ("type","created_at");

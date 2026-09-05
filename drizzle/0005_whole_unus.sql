CREATE TABLE IF NOT EXISTS "candidate_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lane_status_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lane_id" uuid NOT NULL,
	"status" text NOT NULL,
	"healthy" integer NOT NULL,
	"total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_checks" ADD CONSTRAINT "candidate_checks_candidate_id_model_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."model_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_status_snapshots" ADD CONSTRAINT "lane_status_snapshots_lane_id_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_checks_candidate_idx" ON "candidate_checks" USING btree ("candidate_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_status_snapshots_lane_idx" ON "lane_status_snapshots" USING btree ("lane_id","created_at");

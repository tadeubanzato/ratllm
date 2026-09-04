CREATE TABLE "model_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"model_ref" text NOT NULL,
	"display_name" text NOT NULL,
	"provider_name" text,
	"lifecycle" "model_lifecycle" DEFAULT 'DISCOVERED' NOT NULL,
	"free_type" "free_type" DEFAULT 'UNKNOWN' NOT NULL,
	"verified_free" boolean DEFAULT false NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"supports_vision" boolean,
	"supports_tools" boolean,
	"supports_reasoning" boolean,
	"source_url" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_source_model_uidx" ON "model_candidates" USING btree ("source","model_ref");--> statement-breakpoint
CREATE INDEX "candidate_lifecycle_idx" ON "model_candidates" USING btree ("lifecycle");--> statement-breakpoint
CREATE INDEX "candidate_free_idx" ON "model_candidates" USING btree ("free_type","verified_free");
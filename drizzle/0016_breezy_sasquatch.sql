CREATE TABLE "source_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"provider_id" uuid,
	"status" text NOT NULL,
	"http_status" integer,
	"error" text,
	"discovered_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_source_id_model_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."model_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_checks_source_created_idx" ON "source_checks" USING btree ("source_id","created_at");
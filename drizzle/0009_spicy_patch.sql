ALTER TABLE "model_candidates" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "model_candidates" ADD CONSTRAINT "model_candidates_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_provider_idx" ON "model_candidates" USING btree ("provider_id");
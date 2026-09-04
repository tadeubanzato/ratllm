CREATE INDEX "smoke_tests_deployment_created_idx" ON "smoke_tests" USING btree ("deployment_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "deployments_test_due_idx" ON "model_deployments" USING btree ("last_tested_at") WHERE "litellm_deployment_id" IS NOT NULL;

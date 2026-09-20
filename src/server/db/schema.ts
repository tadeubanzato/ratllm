import { relations, sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const providerStatus = pgEnum("provider_status", ["ACTIVE", "DEGRADED", "DISABLED", "AUTH_FAILED"]);
export const adapterCapability = pgEnum("adapter_capability", ["AUTOMATED", "PARTIAL", "MANUAL", "DISABLED"]);
export const modelLifecycle = pgEnum("model_lifecycle", ["DISCOVERED", "CANDIDATE", "ACTIVE", "DEGRADED", "QUARANTINED", "RETIRED", "REMOVED"]);
export const deploymentHealth = pgEnum("deployment_health", ["HEALTHY", "DEGRADED", "RATE_LIMITED", "UNAVAILABLE", "AUTH_ERROR", "UNKNOWN"]);
export const deploymentLifecycle = pgEnum("deployment_lifecycle", ["ACTIVE", "DEACTIVATED", "REMOVED"]);
export const freeType = pgEnum("free_type", ["PERMANENT_FREE", "RECURRING_DAILY", "RECURRING_MONTHLY", "RECURRING_CREDIT", "FREE_TIER", "TRIAL_CREDIT", "TRIAL_QUOTA", "PROMOTIONAL", "OPEN_WEIGHT_SELF_HOSTED", "PROVIDER_SPECIFIC_FREE", "UNKNOWN", "PAID"]);
export const confidence = pgEnum("confidence", ["UNKNOWN", "LOW", "MEDIUM", "HIGH"]);
export const limitSource = pgEnum("limit_source", ["DOCUMENTED", "OBSERVED", "ESTIMATED", "MANUAL", "UNKNOWN"]);
export const runStatus = pgEnum("run_status", ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "ROLLED_BACK", "PARTIAL", "DEFERRED"]);
export const smokeStatus = pgEnum("smoke_status", ["PENDING", "PASSED", "FAILED"]);
export const automationStatus = pgEnum("automation_status", ["IDLE", "RUNNING", "SUCCEEDED", "FAILED", "DISABLED"]);
export const sourceType = pgEnum("source_type", ["PROVIDER_API", "OPENAI_COMPATIBLE", "JSON_FEED", "MANUAL", "CUSTOM_ADAPTER"]);

export const providers = pgTable("providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: providerStatus("status").notNull().default("ACTIVE"),
  adapterKey: text("adapter_key").notNull(),
  adapterCapability: adapterCapability("adapter_capability").notNull().default("MANUAL"),
  baseUrl: text("base_url"),
  enabled: boolean("enabled").notNull().default(true),
  lastDiscoveryAt: timestamp("last_discovery_at", { withTimezone: true }),
  /** CATALOG: defined in providers/catalog.ts. DISCOVERED: created because a source named it (docs/DISCOVERY-PIPELINE.md I3). */
  origin: text("origin").notNull().default("CATALOG"),
  ...timestamps,
}, (table) => [index("providers_status_idx").on(table.status)]);

export const providerCredentialReferences = pgTable("provider_credential_references", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  environmentVariable: text("environment_variable").notNull(),
  encryptedValue: text("encrypted_value"),
  valueHint: text("value_hint"),
  config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  valid: boolean("valid"),
  disabled: boolean("disabled").notNull().default(false),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("credential_provider_env_uidx").on(table.providerId, table.environmentVariable)]);

export const canonicalModels = pgTable("canonical_models", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  family: text("family"),
  lifecycle: modelLifecycle("lifecycle").notNull().default("DISCOVERED"),
  contextWindow: integer("context_window"),
  maxOutputTokens: integer("max_output_tokens"),
  ...timestamps,
});

export const modelCandidates = pgTable("model_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  modelRef: text("model_ref").notNull(),
  displayName: text("display_name").notNull(),
  providerName: text("provider_name"),
  providerId: uuid("provider_id").references(() => providers.id, { onDelete: "set null" }),
  lifecycle: modelLifecycle("lifecycle").notNull().default("DISCOVERED"),
  freeType: freeType("free_type").notNull().default("UNKNOWN"),
  verifiedFree: boolean("verified_free").notNull().default(false),
  contextWindow: integer("context_window"),
  maxOutputTokens: integer("max_output_tokens"),
  supportsVision: boolean("supports_vision"),
  supportsTools: boolean("supports_tools"),
  supportsReasoning: boolean("supports_reasoning"),
  sourceUrl: text("source_url"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** bareModelKey(modelRef), stored so "same model at this provider" is an indexed lookup rather than a scan (I10, I12). */
  modelKey: text("model_key").notNull().default(""),
  // Direct-check state (I6, I7). Real provider calls only; see docs/DISCOVERY-PIPELINE.md §6.
  lastCheckStatus: text("last_check_status"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastPassedAt: timestamp("last_passed_at", { withTimezone: true }),
  consecutivePasses: integer("consecutive_passes").notNull().default(0),
  everFailed: boolean("ever_failed").notNull().default(false),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  /** Why no call can be made right now (null = testable). Not history: it never breaks or extends a streak (I6). */
  checkBlocker: text("check_blocker"),
  /** Stamped by a successful promotion (I11). */
  addedToLitellmAt: timestamp("added_to_litellm_at", { withTimezone: true }),
  addedBy: text("added_by"),
  ...timestamps,
}, (table) => [
  uniqueIndex("candidate_source_model_uidx").on(table.source, table.modelRef), index("candidate_lifecycle_idx").on(table.lifecycle),
  index("candidate_free_idx").on(table.freeType, table.verifiedFree), index("candidate_provider_idx").on(table.providerId),
  index("candidate_provider_key_idx").on(table.providerId, table.modelKey),
  index("candidate_model_key_idx").on(table.modelKey),
  index("candidate_next_check_idx").on(table.nextCheckAt),
  index("candidate_rank_idx").on(table.consecutivePasses, table.lastPassedAt),
  index("candidate_first_seen_idx").on(table.firstSeenAt),
]);

export const candidateChecks = pgTable("candidate_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  candidateId: uuid("candidate_id").notNull().references(() => modelCandidates.id, { onDelete: "cascade" }),
  status: text("status").notNull(), httpStatus: integer("http_status"), error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("candidate_checks_candidate_idx").on(table.candidateId, table.createdAt)]);

export const modelDeployments = pgTable("model_deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  canonicalModelId: uuid("canonical_model_id").notNull().references(() => canonicalModels.id),
  providerId: uuid("provider_id").notNull().references(() => providers.id),
  providerModelId: text("provider_model_id").notNull(),
  litellmDeploymentId: text("litellm_deployment_id"),
  litellmModelName: text("litellm_model_name").notNull(),
  managed: boolean("managed").notNull().default(false),
  managedBy: text("managed_by"),
  curatorVersion: text("curator_version"),
  health: deploymentHealth("health").notNull().default("UNKNOWN"),
  lifecycle: deploymentLifecycle("lifecycle").notNull().default("ACTIVE"),
  freeType: freeType("free_type").notNull().default("UNKNOWN"),
  score: doublePrecision("score"),
  apiBase: text("api_base"),
  rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>().notNull().default({}),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("deployment_identity_uidx").on(table.litellmModelName, table.providerModelId, table.litellmDeploymentId),
  index("deployments_provider_idx").on(table.providerId),
  index("deployments_managed_health_idx").on(table.managed, table.health),
]);

export const modelCapabilities = pgTable("model_capabilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelId: uuid("model_id").notNull().references(() => canonicalModels.id, { onDelete: "cascade" }),
  capability: text("capability").notNull(),
  supported: boolean("supported").notNull(),
  confidence: confidence("confidence").notNull().default("UNKNOWN"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => [uniqueIndex("model_capability_uidx").on(table.modelId, table.capability)]);

export const rateLimitProfiles = pgTable("rate_limit_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  deploymentId: uuid("deployment_id").notNull().references(() => modelDeployments.id, { onDelete: "cascade" }).unique(),
  rpmLimit: integer("rpm_limit"), tpmLimit: integer("tpm_limit"),
  rpmSource: limitSource("rpm_source").notNull().default("UNKNOWN"), tpmSource: limitSource("tpm_source").notNull().default("UNKNOWN"),
  observedRpm: integer("observed_rpm"), observedTpm: integer("observed_tpm"),
  safeRpm: integer("safe_rpm"), safeTpm: integer("safe_tpm"),
  confidence: confidence("confidence").notNull().default("UNKNOWN"),
  confidenceScore: doublePrecision("confidence_score").notNull().default(0),
  sampleCount: integer("sample_count").notNull().default(0),
  manualRpm: integer("manual_rpm"), manualTpm: integer("manual_tpm"),
  lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
  last429At: timestamp("last_429_at", { withTimezone: true }),
  ...timestamps,
});

export const lanes = pgTable("lanes", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(), name: text("name").notNull(), description: text("description").notNull(),
  enabled: boolean("enabled").notNull().default(true), minScore: doublePrecision("min_score").notNull().default(0),
  minimumHealthy: integer("minimum_healthy").notNull().default(2), maximumDeployments: integer("maximum_deployments").notNull().default(8),
  eligibility: jsonb("eligibility").$type<Record<string, unknown>>().notNull().default({}),
  weights: jsonb("weights").$type<Record<string, number>>().notNull().default({}), ...timestamps,
});

export const laneAssignments = pgTable("lane_assignments", {
  id: uuid("id").primaryKey().defaultRandom(), laneId: uuid("lane_id").notNull().references(() => lanes.id, { onDelete: "cascade" }),
  deploymentId: uuid("deployment_id").notNull().references(() => modelDeployments.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull(), score: doublePrecision("score"), pinned: boolean("pinned").notNull().default(false),
  excluded: boolean("excluded").notNull().default(false), explanation: jsonb("explanation").$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
}, (table) => [uniqueIndex("lane_deployment_uidx").on(table.laneId, table.deploymentId), index("lane_priority_idx").on(table.laneId, table.priority)]);

export const laneStatusSnapshots = pgTable("lane_status_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  laneId: uuid("lane_id").notNull().references(() => lanes.id, { onDelete: "cascade" }),
  status: text("status").notNull(), healthy: integer("healthy").notNull(), total: integer("total").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("lane_status_snapshots_lane_idx").on(table.laneId, table.createdAt)]);

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(), type: text("type").notNull(), status: runStatus("status").notNull().default("PENDING"),
  idempotencyKey: text("idempotency_key").unique(), correlationId: text("correlation_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }), finishedAt: timestamp("finished_at", { withTimezone: true }),
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}), error: text("error"), ...timestamps,
}, (table) => [index("sync_runs_created_idx").on(table.createdAt), index("sync_runs_type_created_idx").on(table.type, table.createdAt)]);

export const smokeTests = pgTable("smoke_tests", {
  id: uuid("id").primaryKey().defaultRandom(), runId: uuid("run_id").references(() => syncRuns.id, { onDelete: "set null" }),
  deploymentId: uuid("deployment_id").references(() => modelDeployments.id, { onDelete: "set null" }), lane: text("lane"),
  status: smokeStatus("status").notNull().default("PENDING"), latencyMs: integer("latency_ms"), firstTokenMs: integer("first_token_ms"), httpStatus: integer("http_status"),
  errorCode: text("error_code"), error: text("error"), responseExcerpt: text("response_excerpt"), correlationId: text("correlation_id").notNull(), ...timestamps,
}, (table) => [index("smoke_tests_created_idx").on(table.createdAt)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(), actor: text("actor").notNull(), action: text("action").notNull(), entityType: text("entity_type").notNull(),
  entityId: text("entity_id"), before: jsonb("before").$type<Record<string, unknown>>(), after: jsonb("after").$type<Record<string, unknown>>(),
  correlationId: text("correlation_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_created_idx").on(table.createdAt)]);

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(), value: jsonb("value").notNull(), description: text("description"), ...timestamps,
});

export const leases = pgTable("leases", {
  key: text("key").primaryKey(), owner: text("owner").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const automationJobs = pgTable("automation_jobs", {
  id: uuid("id").primaryKey().defaultRandom(), type: text("type").notNull().unique(), enabled: boolean("enabled").notNull().default(true), schedule: text("schedule").notNull(), customSchedule: boolean("custom_schedule").notNull().default(false), timezone: text("timezone").notNull().default("UTC"), status: automationStatus("status").notNull().default("IDLE"), lastRunAt: timestamp("last_run_at", { withTimezone: true }), nextRunAt: timestamp("next_run_at", { withTimezone: true }), durationMs: integer("duration_ms"), failureCount: integer("failure_count").notNull().default(0), lastError: text("last_error"),
  runRequestedAt: timestamp("run_requested_at", { withTimezone: true }), requestedOptions: jsonb("requested_options").$type<{ candidateScope?: "due" | "connected" }>(), ...timestamps,
}, (table) => [index("automation_jobs_due_idx").on(table.enabled, table.nextRunAt)]);

export const modelSources = pgTable("model_sources", {
  id: uuid("id").primaryKey().defaultRandom(), name: text("name").notNull(), type: sourceType("type").notNull(), providerId: uuid("provider_id").references(() => providers.id, { onDelete: "set null" }), url: text("url"), enabled: boolean("enabled").notNull().default(true), priority: integer("priority").notNull().default(100), credentialReference: text("credential_reference"), adapterReference: text("adapter_reference"), lastSyncAt: timestamp("last_sync_at", { withTimezone: true }), status: text("status").notNull().default("UNKNOWN"), discoveredModelCount: integer("discovered_model_count").notNull().default(0),
  lastError: text("last_error"), lastSuccessAt: timestamp("last_success_at", { withTimezone: true }), ...timestamps,
});

export const sourceChecks = pgTable("source_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => modelSources.id, { onDelete: "cascade" }),
  providerId: uuid("provider_id").references(() => providers.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  httpStatus: integer("http_status"),
  error: text("error"),
  discoveredCount: integer("discovered_count"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("source_checks_source_created_idx").on(table.sourceId, table.createdAt)]);

/** What a source says about a provider's free offer (docs/DISCOVERY-PIPELINE.md §5). Text fields are the source's own
 *  wording, kept verbatim: a quoted limit cannot be wrong, a parsed one can. One row per (provider, source). */
export const providerOffers = pgTable("provider_offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  freeType: freeType("free_type").notNull().default("UNKNOWN"),
  freeTierText: text("free_tier_text"),
  rateLimitsText: text("rate_limits_text"),
  notes: text("notes"),
  expiresAt: text("expires_at"),
  cardRequired: boolean("card_required"),
  phoneRequired: boolean("phone_required"),
  commercialOk: boolean("commercial_ok"),
  openaiBaseUrl: text("openai_base_url"),
  docsUrl: text("docs_url"),
  sourceVerified: boolean("source_verified"),
  sourceLastVerified: text("source_last_verified"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("provider_offer_uidx").on(table.providerId, table.source)]);

export const providersRelations = relations(providers, ({ many }) => ({ deployments: many(modelDeployments), credentials: many(providerCredentialReferences) }));
export const modelsRelations = relations(canonicalModels, ({ many }) => ({ deployments: many(modelDeployments), capabilities: many(modelCapabilities) }));
export const deploymentsRelations = relations(modelDeployments, ({ one, many }) => ({
  provider: one(providers, { fields: [modelDeployments.providerId], references: [providers.id] }),
  model: one(canonicalModels, { fields: [modelDeployments.canonicalModelId], references: [canonicalModels.id] }),
  assignments: many(laneAssignments),
}));

export const touchUpdatedAt = { updatedAt: sql`now()` };

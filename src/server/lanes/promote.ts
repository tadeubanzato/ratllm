import "server-only";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { CURATOR_MANAGED_BY, CURATOR_VERSION, type LaneId } from "@/lib/constants";
import { getDb } from "@/server/db/client";
import { auditEvents, laneAssignments, lanes, modelCandidates, providerCredentialReferences, providers, syncRuns } from "@/server/db/schema";
import { HttpLiteLLMAdapter, LiteLLMError } from "@/server/litellm/client";
import { syncLiteLLM } from "@/server/litellm/sync";
import { resolveProvider } from "@/server/providers/catalog";
import { bareModelKey } from "@/server/discovery/model-key";
import { bareCandidateModelRef, resolveCredentialSecret, resolveVerificationEndpoint, verifyCandidateDirectly } from "@/server/discovery/verify";
import { classifyCandidateLanes } from "./rules";
import { syncFallbackConfig } from "./fallbacks";
import { getDeploymentsForProvider } from "./shared";

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Raised when a candidate cannot be added to LiteLLM for a reason the user must fix first (no credential, no endpoint, provider down). */
export class PromotionBlocked extends Error {
  constructor(message: string) { super(message); this.name = "PromotionBlocked"; }
}

type Candidate = typeof modelCandidates.$inferSelect;
type ProviderDefinition = NonNullable<ReturnType<typeof resolveProvider>>;

export interface PromotionContext {
  candidate: Candidate;
  definition: ProviderDefinition;
  providerRow: typeof providers.$inferSelect;
  credential: typeof providerCredentialReferences.$inferSelect;
  apiKey: string;
  bareModel: string;
  apiBase: string;
  directAliasName: string;
}

/** Resolves everything needed to register this candidate in LiteLLM, or throws PromotionBlocked with the exact gap. */
export async function resolvePromotionContext(candidateId: string): Promise<PromotionContext> {
  const db = getDb();
  const candidate = (await db.select().from(modelCandidates).where(eq(modelCandidates.id, candidateId)).limit(1))[0];
  if (!candidate) throw new PromotionBlocked("Candidate not found");

  const definition = resolveProvider(candidate.source === "openrouter" ? "openrouter" : candidate.providerName, candidate.modelRef);
  if (!definition) throw new PromotionBlocked("No known provider resolves for this candidate");

  const providerRow = (await db.select().from(providers).where(eq(providers.slug, definition.slug)).limit(1))[0];
  if (!providerRow) throw new PromotionBlocked(`${definition.name} is not registered yet — run discovery first`);

  const credential = (await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, providerRow.id)).limit(1))[0];
  if (!credential) throw new PromotionBlocked(`Add a credential for ${definition.name} first`);
  if (credential.valid !== true) throw new PromotionBlocked(`Verify the ${definition.name} credential first`);

  const chatUrl = resolveVerificationEndpoint(definition, providerRow.baseUrl);
  if (!chatUrl) throw new PromotionBlocked(`${definition.name} has no known OpenAI-compatible endpoint`);

  const apiKey = resolveCredentialSecret(credential);
  if (!apiKey) throw new PromotionBlocked(`Credential ${credential.environmentVariable} is not available to the server`);

  const bareModel = bareCandidateModelRef({ modelRef: candidate.modelRef, source: candidate.source, provider: definition, providerBaseUrl: providerRow.baseUrl });
  return { candidate, definition, providerRow, credential, apiKey, bareModel, apiBase: chatUrl.replace(/\/chat\/completions$/, ""), directAliasName: `${definition.slug}/${bareModel}` };
}

export interface TargetResult {
  target: string;
  lane: LaneId | null;
  status: "added" | "exists" | "failed";
  deploymentId: string | null;
  smokeOk?: boolean;
  error?: string;
}

export interface PromoteOptions { lanes?: LaneId[]; directAlias?: boolean; skipFallbackSync?: boolean }

export interface PromoteResult {
  candidateId: string;
  runId: string;
  ok: boolean;
  targets: TargetResult[];
}

function providerModelId(bareModel: string) { return `openai/${bareModel}`; }

async function registerTarget(ctx: PromotionContext, modelName: string, lane: LaneId | null, adapter: HttpLiteLLMAdapter): Promise<TargetResult> {
  const key = bareModelKey(providerModelId(ctx.bareModel));
  const existing = (await getDeploymentsForProvider(ctx.providerRow.id))
    .find(row => row.litellmModelName === modelName && bareModelKey(row.providerModelId) === key && row.litellmDeploymentId && row.health !== "UNAVAILABLE");
  if (existing) return { target: modelName, lane, status: "exists", deploymentId: existing.id };

  let lastError = "LiteLLM rejected the deployment";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await adapter.addDeployment({
        modelName,
        model: providerModelId(ctx.bareModel),
        apiKey: ctx.apiKey,
        apiBase: ctx.apiBase,
        metadata: {
          managed_by: CURATOR_MANAGED_BY, curator_version: CURATOR_VERSION, source_provider: ctx.definition.name,
          source_model: ctx.candidate.modelRef, source_candidate_id: ctx.candidate.id, free_type: ctx.candidate.freeType,
          ...(lane ? { lane } : {}),
        },
      });
      return { target: modelName, lane, status: "added", deploymentId: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "LiteLLM rejected the deployment";
      const httpStatus = error instanceof LiteLLMError ? error.status : undefined;
      if (httpStatus && httpStatus < 500 && httpStatus !== 429) break; // a 4xx won't fix itself on retry
      if (attempt < MAX_ATTEMPTS) await sleep(400 * 2 ** attempt);
    }
  }
  return { target: modelName, lane, status: "failed", deploymentId: null, error: lastError };
}

/**
 * Adds a discovered candidate to LiteLLM as a member of one or more `smart-*` lanes (and optionally its own
 * direct alias). Idempotent, retries transient LiteLLM errors, and returns a per-target result so a partial
 * failure keeps its successes. Every new lane member is smoke-tested and bound into `lane_assignments`.
 */
export async function promoteCandidate(candidateId: string, options: PromoteOptions = {}): Promise<PromoteResult> {
  const db = getDb();
  const adapter = new HttpLiteLLMAdapter();
  const correlationId = randomUUID();
  const [run] = await db.insert(syncRuns).values({ type: "CANDIDATE_PROMOTE", status: "RUNNING", correlationId, startedAt: new Date(), summary: { candidateId } }).returning();

  try {
    const ctx = await resolvePromotionContext(candidateId);

    // Prove the provider still serves it, via the exact endpoint+credential LiteLLM will use, before we touch the router.
    const live = await verifyCandidateDirectly({ modelRef: ctx.candidate.modelRef, source: ctx.candidate.source, provider: ctx.definition, providerBaseUrl: ctx.providerRow.baseUrl, credential: ctx.credential });
    if (live.status !== "available") throw new PromotionBlocked(`Provider check failed (${live.status}${live.httpStatus ? ` HTTP ${live.httpStatus}` : ""}); not adding to LiteLLM`);

    const classified = classifyCandidateLanes(ctx.candidate);
    const explicit = options.lanes && options.lanes.length ? options.lanes : null;
    const laneSlugs = (explicit ?? classified.filter(match => match.recommended).map(match => match.slug))
      .filter((slug, index, all) => all.indexOf(slug) === index);
    const directAlias = options.directAlias ?? false;
    if (!laneSlugs.length && !directAlias) throw new PromotionBlocked("No lane matched this model — pick one explicitly or enable the direct alias");

    const plan: { modelName: string; lane: LaneId | null }[] = [
      ...laneSlugs.map(slug => ({ modelName: slug as string, lane: slug })),
      ...(directAlias ? [{ modelName: ctx.directAliasName, lane: null }] : []),
    ];

    const results: TargetResult[] = [];
    for (const target of plan) results.push(await registerTarget(ctx, target.modelName, target.lane, adapter));

    if (results.some(result => result.status === "added")) await syncLiteLLM({ dryRun: false }, adapter);

    const key = bareModelKey(providerModelId(ctx.bareModel));
    const deployments = await getDeploymentsForProvider(ctx.providerRow.id);
    const laneRows = await db.select().from(lanes);

    for (const result of results) {
      if (result.status === "failed" || !result.lane) continue;
      const deployment = deployments.find(row => row.litellmModelName === result.lane && bareModelKey(row.providerModelId) === key);
      if (!deployment) { result.status = "failed"; result.error = "Deployment did not appear after inventory sync"; continue; }
      result.deploymentId = deployment.id;
      const laneRow = laneRows.find(row => row.slug === result.lane);
      if (!laneRow) continue;

      const smoke = await adapter.smokeTest(result.lane);
      result.smokeOk = smoke.ok;
      const match = classified.find(item => item.slug === result.lane);
      const score = match?.score ?? 0.5;
      const explanation = {
        source: explicit ? "MANUAL" : "AUTO",
        reason: match?.reason ?? "manual selection",
        smokeOk: smoke.ok,
        lastError: smoke.ok ? null : smoke.error ?? null,
        boundAt: new Date().toISOString(),
      };
      await db.insert(laneAssignments).values({
        laneId: laneRow.id, deploymentId: deployment.id, priority: Math.round((1 - score) * 100), score, pinned: Boolean(explicit), explanation,
      }).onConflictDoUpdate({ target: [laneAssignments.laneId, laneAssignments.deploymentId], set: { score, excluded: false, pinned: Boolean(explicit), explanation, updatedAt: new Date() } });
    }

    // A member of any lane changes the fallback pool for the lanes that fall back to it — keep the router in sync.
    // The reconciler passes skipFallbackSync and pushes once at the end of its batch instead.
    if (!options.skipFallbackSync) await syncFallbackConfig(adapter).catch(() => undefined);

    const ok = results.every(result => result.status !== "failed");
    const summary = { candidateId, ok, targets: results };
    await db.update(syncRuns).set({ status: ok ? "SUCCEEDED" : "FAILED", finishedAt: new Date(), summary, error: ok ? null : "One or more lane targets failed", updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    await db.insert(auditEvents).values({ actor: "user", action: "litellm.candidate.promoted", entityType: "model_candidate", entityId: candidateId, after: summary, correlationId });
    return { candidateId, runId: run.id, ok, targets: results };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Promotion failed";
    await db.update(syncRuns).set({ status: "FAILED", finishedAt: new Date(), error: message, updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    throw error;
  }
}

/** Back-compat: the old single-call promote now means "recommended lanes, no direct alias". */
export async function promoteCandidateToLiteLLM(candidateId: string) {
  return promoteCandidate(candidateId);
}

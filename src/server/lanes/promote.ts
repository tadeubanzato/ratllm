import "server-only";
import { candidateOnlyBlockReason } from "@/server/discovery/promotion-gate";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { CURATOR_MANAGED_BY, CURATOR_VERSION, type LaneId } from "@/lib/constants";
import { getDb } from "@/server/db/client";
import { auditEvents, laneAssignments, lanes, modelCandidates, modelDeployments, providerCredentialReferences, providerOffers, providers, syncRuns } from "@/server/db/schema";
import { HttpLiteLLMAdapter, LiteLLMError } from "@/server/litellm/client";
import { syncLiteLLM } from "@/server/litellm/sync";
import type { ProviderDefinition as CatalogProviderDefinition } from "@/server/providers/catalog";
import { definitionForProvider } from "@/server/providers/attribution";
import { promotionGateReason } from "@/server/discovery/verification-policy";
import { buildExtraHeaders, endpointBaseHint } from "@/server/providers/wiring";
import { deploymentModelKey } from "@/server/discovery/model-key";
import { removalHistoryOf } from "@/server/discovery/auto-add-policy";
import { bareCandidateModelRef, resolveCredentialWithSource, resolveVerificationEndpoint, verifyCandidateDirectly } from "@/server/discovery/verify";
import { getGigaChatAccessToken } from "@/server/providers/gigachat";
import { credentialProvenance } from "@/server/credentials/fingerprint";
import { nonChatModelReason } from "@/server/discovery/model-type";
import { classifyCandidateLanes } from "./rules";
import { syncFallbackConfig } from "./fallbacks";
import { getDeploymentsForProvider, laneHasCapacity } from "./shared";
import { findExistingTarget } from "./existing-target";
import { promotionRunStatus } from "./promotion-status";

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Raised when a candidate cannot be added to LiteLLM for a reason the user must fix first (no credential, no endpoint, provider down). */
export class PromotionBlocked extends Error {
  constructor(message: string) { super(message); this.name = "PromotionBlocked"; }
}

/** A block that is an expected waiting state rather than a failure — every recommended lane is full, no lane fits yet, or
 *  a credential/provider prerequisite hasn't been set up. Recorded as a DEFERRED run (not FAILED) so the Runs page and
 *  failure counts show real problems, and auto-add backs off instead of retrying the same dead end every hour. */
export class PromotionDeferred extends PromotionBlocked {
  constructor(message: string) { super(message); this.name = "PromotionDeferred"; }
}

type Candidate = typeof modelCandidates.$inferSelect;
type ProviderDefinition = CatalogProviderDefinition;

export interface PromotionContext {
  candidate: Candidate;
  definition: ProviderDefinition;
  providerRow: typeof providers.$inferSelect;
  credential: typeof providerCredentialReferences.$inferSelect;
  apiKey: string;
  /** Which credential row, and where its value came from, so the deployment can record it (never the value itself). */
  credentialProvenance: ReturnType<typeof credentialProvenance>;
  bareModel: string;
  apiBase: string;
  directAliasName: string;
  /** What to pass as the base URL for this provider's endpoint; see endpointBaseHint. */
  endpointHint: string | null;
}

/** Resolves everything needed to register this candidate in LiteLLM, or throws PromotionBlocked with the exact gap. */
/** `allowNonChat` lifts the "not a chat model" block for ONE deliberate case: a person adding a model that demonstrably answers chat requests
 *  (a safety classifier such as Groq's Prompt Guard) as a direct alias. Everything else about the candidate is still checked. */
export async function resolvePromotionContext(candidateId: string, options: { allowNonChat?: boolean } = {}): Promise<PromotionContext> {
  const db = getDb();
  const candidate = (await db.select().from(modelCandidates).where(eq(modelCandidates.id, candidateId)).limit(1))[0];
  if (!candidate) throw new PromotionBlocked("Candidate not found");

  const evidence = candidate.evidence as Record<string, unknown>;
  const blockedReason = (typeof evidence?.nonChatReason === "string" ? evidence.nonChatReason : null) ?? nonChatModelReason({ modelRef: candidate.modelRef, displayName: candidate.displayName, description: typeof evidence?.description === "string" ? evidence.description : null });
  if (blockedReason && !options.allowNonChat) throw new PromotionBlocked(blockedReason);

  const authorityReason = candidateOnlyBlockReason(candidate);
  if (authorityReason) throw new PromotionBlocked(authorityReason);

  // The provider is the one discovery decided and stored (docs/DISCOVERY-PIPELINE.md I1); it is never re-guessed from text here.
  if (!candidate.providerId) throw new PromotionBlocked("No provider has been resolved for this candidate");
  const providerRow = (await db.select().from(providers).where(eq(providers.id, candidate.providerId)).limit(1))[0];
  if (!providerRow) throw new PromotionDeferred("This candidate's provider is not registered yet — run discovery first");
  const definition = definitionForProvider(providerRow);

  const credential = (await db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, providerRow.id)).limit(1))[0];
  if (!credential) throw new PromotionDeferred(`Add a credential for ${definition.name} first`);
  if (credential.valid !== true) throw new PromotionDeferred(`Verify the ${definition.name} credential first`);

  // A provider the catalog has no wiring for is reachable at the OpenAI-compatible base URL a source published for it.
  const offerBaseUrl = (await db.select({ url: providerOffers.openaiBaseUrl }).from(providerOffers).where(eq(providerOffers.providerId, providerRow.id))).map(row => row.url).find(Boolean) ?? null;
  const endpointHint = endpointBaseHint(providerRow.slug, providerRow.baseUrl, offerBaseUrl);
  const chatUrl = resolveVerificationEndpoint(definition, endpointHint);
  if (!chatUrl) throw new PromotionBlocked(`${definition.name} has no known OpenAI-compatible endpoint`);

  const resolved = resolveCredentialWithSource(credential);
  if (!resolved) throw new PromotionBlocked(`Credential ${credential.environmentVariable} is not available to the server`);
  // GigaChat's stored credential is an OAuth "Authorization key" — LiteLLM needs an actual Bearer token in its
  // static api_key slot. This gives it a fresh one at promotion time; gigachat.ts's refresh job keeps it alive
  // afterward, since the token itself expires in ~30 minutes.
  let apiKey = resolved.secret;
  if (definition.slug === "gigachat") {
    const tokenResult = await getGigaChatAccessToken(resolved.secret);
    if ("error" in tokenResult) throw new PromotionDeferred(`GigaChat token exchange failed: ${tokenResult.error}`);
    apiKey = tokenResult.token;
  }

  const bareModel = bareCandidateModelRef({ modelRef: candidate.modelRef, source: candidate.source, provider: definition, providerBaseUrl: endpointHint });
  return { candidate, definition, providerRow, credential, apiKey, credentialProvenance: credentialProvenance(credential, resolved), bareModel, apiBase: chatUrl.replace(/\/chat\/completions$/, ""), directAliasName: `${definition.slug}/${bareModel}`, endpointHint };
}

export interface TargetResult {
  target: string;
  lane: LaneId | null;
  status: "added" | "exists" | "failed";
  deploymentId: string | null;
  smokeOk?: boolean;
  error?: string;
}

/** `allowNonChat`: a manual override for a model classified as not-a-chat-model. It is only ever added as a direct alias, never into a lane
 *  (a classifier in a lane would answer real traffic with scores), and never automatically. */
export interface PromoteOptions { lanes?: LaneId[]; directAlias?: boolean; skipFallbackSync?: boolean; trigger?: "manual" | "auto"; allowNonChat?: boolean }

export interface PromoteResult {
  candidateId: string;
  runId: string;
  ok: boolean;
  targets: TargetResult[];
}

function providerModelId(bareModel: string) { return `openai/${bareModel}`; }

async function registerTarget(ctx: PromotionContext, modelName: string, lane: LaneId | null, adapter: HttpLiteLLMAdapter): Promise<TargetResult> {
  const existing = findExistingTarget(await getDeploymentsForProvider(ctx.providerRow.id), modelName, providerModelId(ctx.bareModel));
  if (existing) return { target: modelName, lane, status: "exists", deploymentId: existing.id };

  let lastError = "LiteLLM rejected the deployment";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await adapter.addDeployment({
        modelName,
        model: providerModelId(ctx.bareModel),
        apiKey: ctx.apiKey,
        apiBase: ctx.apiBase,
        extraHeaders: buildExtraHeaders(ctx.definition.slug, ctx.credential.config),
        // LiteLLM runs as a separate service this app doesn't control the TLS trust store of — it can't be made to
        // trust GigaChat's Russian government CA chain the way our own verification calls are (providers/gigachat.ts).
        // This mirrors what LiteLLM's own native GigaChat integration does, scoped to only this provider's deployments.
        sslVerify: ctx.definition.slug === "gigachat" ? false : undefined,
        metadata: {
          managed_by: CURATOR_MANAGED_BY, curator_version: CURATOR_VERSION, source_provider: ctx.definition.name,
          source_model: ctx.candidate.modelRef, source_candidate_id: ctx.candidate.id, free_type: ctx.candidate.freeType,
          ...ctx.credentialProvenance,
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
    if (options.allowNonChat && (options.trigger === "auto" || !options.directAlias || (options.lanes && options.lanes.length)))
      throw new PromotionBlocked("A model that is not a chat model can only be added by hand, as a direct alias, never into a lane");
    const ctx = await resolvePromotionContext(candidateId, { allowNonChat: options.allowNonChat });

    // The 5-in-a-row rule is enforced here, on the server, for every path (button, API, automation): hiding a button is never
    // the only enforcement (docs/DISCOVERY-PIPELINE.md I8). A model that has been in LiteLLM before keeps the human-override path.
    const everInLiteLLM = removalHistoryOf(ctx.candidate.evidence).length > 0 || ctx.candidate.addedToLitellmAt !== null
      || (await db.select({ id: modelDeployments.id, key: modelDeployments.providerModelId }).from(modelDeployments).where(eq(modelDeployments.providerId, ctx.providerRow.id))).some(row => deploymentModelKey(row.key) === ctx.candidate.modelKey);
    // Only a first-time addition needs the streak. A model already in LiteLLM once (a lane repair by the reconciler, or a person
    // deciding to add it back) is re-verified live just below, which is the check that matters for it.
    const gate = everInLiteLLM || options.allowNonChat ? null : promotionGateReason({ consecutivePasses: ctx.candidate.consecutivePasses, lastCheckStatus: ctx.candidate.lastCheckStatus, previouslyInLiteLLM: false });
    if (gate) throw new PromotionBlocked(`Not eligible yet: ${gate}`);

    // Prove the provider still serves it, via the exact endpoint+credential LiteLLM will use, before we touch the router.
    // A 429 here is exactly as inconclusive as it is everywhere else in this app (computeFailureStreak explicitly
    // never counts one, verify-due.ts just backs off and retries later) — one unlucky rate limit at the instant
    // someone clicks "Add" shouldn't permanently block a candidate with a 100% pass history. Retry it the same way
    // registerTarget below already retries transient LiteLLM errors, before giving up and blocking.
    let live = await verifyCandidateDirectly({ modelRef: ctx.candidate.modelRef, source: ctx.candidate.source, provider: ctx.definition, providerBaseUrl: ctx.endpointHint, credential: ctx.credential });
    for (let attempt = 1; attempt < MAX_ATTEMPTS && live.status === "rate_limited"; attempt++) {
      await sleep(400 * 2 ** attempt);
      live = await verifyCandidateDirectly({ modelRef: ctx.candidate.modelRef, source: ctx.candidate.source, provider: ctx.definition, providerBaseUrl: ctx.endpointHint, credential: ctx.credential });
    }
    if (live.status !== "available") throw new PromotionBlocked(`Provider check failed (${live.status}${live.httpStatus ? ` HTTP ${live.httpStatus}` : ""}); not adding to LiteLLM`);

    const classified = classifyCandidateLanes(ctx.candidate);
    const explicit = options.lanes && options.lanes.length ? options.lanes : null;
    const deduped = (options.allowNonChat ? [] : explicit ?? classified.filter(match => match.recommended).map(match => match.slug))
      .filter((slug, index, all) => all.indexOf(slug) === index);
    // Each lane's maxDeployments is a real cap, not just UI copy: an explicit (manual or reconcile-repair) selection
    // is trusted as-is, but auto-selected "recommended" lanes are checked here so an unattended pass (auto-add,
    // scheduled re-verification) can never silently overfill a lane past what the manual picker itself refuses.
    const laneSlugs = explicit ? deduped : (await Promise.all(deduped.map(async slug => (await laneHasCapacity(slug)) ? slug : null))).filter((slug): slug is LaneId => slug !== null);
    const directAlias = options.directAlias ?? false;
    if (!laneSlugs.length && !directAlias) {
      if (!explicit && deduped.length) throw new PromotionDeferred("All recommended lanes are at capacity");
      throw new PromotionDeferred("No lane matched this model — pick one explicitly or enable the direct alias");
    }

    const plan: { modelName: string; lane: LaneId | null }[] = [
      ...laneSlugs.map(slug => ({ modelName: slug as string, lane: slug })),
      ...(directAlias ? [{ modelName: ctx.directAliasName, lane: null }] : []),
    ];

    const results: TargetResult[] = [];
    for (const target of plan) results.push(await registerTarget(ctx, target.modelName, target.lane, adapter));

    if (results.some(result => result.status === "added")) await syncLiteLLM({ dryRun: false }, adapter);

    const key = deploymentModelKey(providerModelId(ctx.bareModel));
    const deployments = await getDeploymentsForProvider(ctx.providerRow.id);
    const laneRows = await db.select().from(lanes);

    for (const result of results) {
      if (result.status === "failed" || !result.lane) continue;
      const deployment = deployments.find(row => row.litellmModelName === result.lane && deploymentModelKey(row.providerModelId) === key);
      if (!deployment) { result.status = "failed"; result.error = "Deployment did not appear after inventory sync"; continue; }
      result.deploymentId = deployment.id;
      const laneRow = laneRows.find(row => row.slug === result.lane);
      if (!laneRow) continue;

      // The new deployment's OWN probe, by its router id. Probing the lane alias asks whichever of the lane's members LiteLLM picks (a lane holds
      // up to twenty), so a slow or broken neighbour was recorded as this model failing — the same trap the health monitor already avoids.
      const smoke = await adapter.smokeTest(deployment.litellmDeploymentId ?? result.lane);
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
    // A failure here is not ignorable: it is reported in the run and makes it PARTIAL (see promotion-status.ts).
    const fallback = options.skipFallbackSync ? null : await syncFallbackConfig(adapter).catch(error => ({ ok: false, applied: [], errors: [{ model: "*", type: "general", error: error instanceof Error ? error.message : "fallback sync failed" }] }));

    const ok = results.every(result => result.status !== "failed");
    // "Added <date>" (I11): stamped when something was actually registered, by whom. A no-op re-run against a deployment that was
    // already there must not move the date.
    if (ok && results.some(result => result.status === "added"))
      await db.update(modelCandidates).set({ addedToLitellmAt: new Date(), addedBy: options.trigger === "auto" ? "auto" : "manual", updatedAt: new Date() }).where(eq(modelCandidates.id, candidateId));
    // A manual promotion (someone clicking "Add to LiteLLM" themselves, including on a flap-limited candidate the
    // UI is offering the button back for) is the human review the flap limit exists to require — clear the
    // candidate's removal history so it starts this run with a clean slate rather than carrying old flaps forward
    // forever. An automatic re-add must never do this itself, or the flap limit could never actually trigger.
    // See auto-add-policy.ts and docs/FREE-MODEL-LIFECYCLE.md §5.
    if (ok && options.trigger !== "auto" && removalHistoryOf(ctx.candidate.evidence).length)
      await db.update(modelCandidates).set({ evidence: { ...ctx.candidate.evidence, removalHistory: [] }, updatedAt: new Date() }).where(eq(modelCandidates.id, candidateId));
    const fallbackOk = fallback ? fallback.ok : true; // null = the caller (the reconciler) pushes fallbacks itself, once, at the end of its batch
    const summary = { candidateId, ok, targets: results, fallback: fallback ? { ok: fallback.ok, errors: fallback.errors } : null };
    const outcome = promotionRunStatus({ targetsFailed: results.filter(result => result.status === "failed").length, targetsTotal: results.length, fallbackOk });
    await db.update(syncRuns).set({ status: outcome.status, finishedAt: new Date(), summary, error: outcome.error, updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    await db.insert(auditEvents).values({ actor: "user", action: "litellm.candidate.promoted", entityType: "model_candidate", entityId: candidateId, after: summary, correlationId });
    return { candidateId, runId: run.id, ok, targets: results };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Promotion failed";
    await db.update(syncRuns).set({ status: error instanceof PromotionDeferred ? "DEFERRED" : "FAILED", finishedAt: new Date(), error: message, updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    throw error;
  }
}

/** Back-compat: the old single-call promote now means "recommended lanes, no direct alias". */
export async function promoteCandidateToLiteLLM(candidateId: string) {
  return promoteCandidate(candidateId);
}

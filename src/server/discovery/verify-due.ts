import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { candidateChecks, modelCandidates, modelDeployments, providerCredentialReferences, providerOffers, providers } from "@/server/db/schema";
import { definitionForProvider } from "@/server/providers/attribution";
import { endpointBaseHint } from "@/server/providers/wiring";
import { PromotionDeferred, promoteCandidate } from "@/server/lanes/promote";
import { getLiteLLMManagementSettings } from "@/server/settings/litellm-management";
import { log } from "@/server/logging";
import { autoAddDeferredUntil, isAutoAddDeferred, isAutoReAddBlocked } from "./auto-add-policy";
import { candidateOnlyBlockReason } from "./promotion-gate";
import { bareModelKey } from "./model-key";
import { reconcileCheckBlockers, type CheckBlocker } from "./blockers";
import { verifyCandidateDirectly, type CandidateVerificationStatus } from "./verify";
import { applyCheckOutcome, effectiveFreeKind, PROMOTION_PASSES, type CheckOutcome } from "./verification-policy";

type Candidate = typeof modelCandidates.$inferSelect;
type ProviderRow = typeof providers.$inferSelect;
type CredentialRow = typeof providerCredentialReferences.$inferSelect;
type VerificationRow = { id: string; model: string; provider: string | null; status: CandidateVerificationStatus; httpStatus: number | null; error: string | null; nextCheckAt: string | null };

/** Everything a check needs that is not the candidate itself. These tables are small (providers, their credentials, offers,
 *  LiteLLM deployments) however many candidates exist, so a pass loads them once instead of once per candidate (I12). */
interface Context {
  providers: Map<string, ProviderRow>;
  credentials: Map<string, CredentialRow>;
  offerBaseUrls: Map<string, string>;
  offerFreeTypes: Map<string, string[]>;
  /** (provider, model key) of every model that is live in LiteLLM right now. */
  live: Set<string>;
}
const liveKey = (providerId: string, modelKey: string) => `${providerId}\u0000${modelKey}`;

async function loadContext(db: ReturnType<typeof getDb>): Promise<Context> {
  const [providerRows, credentialRows, offerRows, deploymentRows] = await Promise.all([
    db.select().from(providers),
    db.select().from(providerCredentialReferences).where(eq(providerCredentialReferences.disabled, false)),
    db.select({providerId: providerOffers.providerId, openaiBaseUrl: providerOffers.openaiBaseUrl, freeType: providerOffers.freeType}).from(providerOffers),
    db.select({providerId: modelDeployments.providerId, providerModelId: modelDeployments.providerModelId}).from(modelDeployments).where(eq(modelDeployments.lifecycle, "ACTIVE")),
  ]);
  const credentials = new Map<string, CredentialRow>();
  // A verified credential beats an unverified one when a provider has several.
  for (const row of [...credentialRows].sort((a, b) => Number(b.valid === true) - Number(a.valid === true))) if (!credentials.has(row.providerId)) credentials.set(row.providerId, row);
  const offerBaseUrls = new Map<string, string>(), offerFreeTypes = new Map<string, string[]>();
  for (const offer of offerRows) {
    if (offer.openaiBaseUrl && !offerBaseUrls.has(offer.providerId)) offerBaseUrls.set(offer.providerId, offer.openaiBaseUrl);
    offerFreeTypes.set(offer.providerId, [...(offerFreeTypes.get(offer.providerId) ?? []), offer.freeType]);
  }
  return {
    providers: new Map(providerRows.map(row => [row.id, row])), credentials, offerBaseUrls, offerFreeTypes,
    live: new Set(deploymentRows.map(row => liveKey(row.providerId, bareModelKey(row.providerModelId)))),
  };
}

/** Records that auto-add hit an expected waiting state for this candidate, so it isn't retried for a while. A jsonb merge
 *  rather than read-modify-write: the caller's copy of the row's evidence is stale by the time this runs. */
export async function markAutoAddDeferred(db: ReturnType<typeof getDb>, candidateId: string) {
  await db.update(modelCandidates).set({evidence: sql`${modelCandidates.evidence} || ${JSON.stringify({autoAddDeferredUntil: autoAddDeferredUntil()})}::jsonb`}).where(eq(modelCandidates.id, candidateId));
}

/** A candidate that has now passed PROMOTION_PASSES real checks in a row, and isn't already in LiteLLM, is added
 *  automatically — the same as clicking "Add to LiteLLM" and accepting the pre-checked lanes (docs/DISCOVERY-PIPELINE.md I8).
 *  `promoteCandidate` re-verifies live before touching the router, so this never adds anything that would not pass right now. */
async function autoAddIfEligible(db: ReturnType<typeof getDb>, row: Candidate, streak: number, context: Context) {
  if (streak < PROMOTION_PASSES || !row.providerId) return;
  const key = liveKey(row.providerId, row.modelKey);
  if (context.live.has(key)) return;
  // A candidate that's been auto-removed before doesn't get an immediate second chance the instant checks pass again — see
  // auto-add-policy.ts and docs/FREE-MODEL-LIFECYCLE.md §5 (cooldown against same-cycle flapping, flap limit against a model
  // that is fine standalone but repeatedly broken specifically through LiteLLM).
  if (isAutoReAddBlocked(row.evidence)) return;
  // A recent deferral (lanes full, credential not ready) is a waiting state, not something to retry every cycle.
  if (isAutoAddDeferred(row.evidence)) return;
  if (candidateOnlyBlockReason(row)) return;
  try {
    await promoteCandidate(row.id, {trigger: "auto"});
    context.live.add(key);
    log("info", "Auto-added candidate to LiteLLM", {candidateId: row.id, modelRef: row.modelRef});
  } catch (error) {
    if (error instanceof PromotionDeferred) {
      // jsonb merge, not a read-modify-write: the row's evidence in hand is a stale copy.
      await markAutoAddDeferred(db, row.id);
      log("info", "Auto-add deferred", {candidateId: row.id, reason: error.message});
      return;
    }
    log("warn", "Auto-add did not go through", {candidateId: row.id, error: error instanceof Error ? error.message : String(error)});
  }
}

const BLOCKER_OF_NON_CALL: Partial<Record<CandidateVerificationStatus, CheckBlocker>> = {
  provider_unresolved: "PROVIDER_UNRESOLVED", provider_not_configured: "NO_ENDPOINT", credential_missing: "CREDENTIAL_MISSING", credential_unverified: "CREDENTIAL_UNVERIFIED",
};

/** Runs one real test call for a candidate and records its outcome (invariants I6, I7): a candidate_checks row, and the stored
 *  state (latest result, latest pass, streak, next check). When `providerBackoff` is a Map, a provider that answered 429
 *  earlier in the batch is not called again: the candidate is only rescheduled, and no check is recorded, because no call was
 *  made. Pass `null` to force a real request for every candidate regardless. */
async function checkCandidate(db: ReturnType<typeof getDb>, row: Candidate, context: Context, providerBackoff: Map<string, string> | null, autoAdd: boolean): Promise<VerificationRow | null> {
  const provider = row.providerId ? context.providers.get(row.providerId) : undefined;
  if (!provider) return null; // no provider means a blocker, which reconcileCheckBlockers owns
  const base = {id: row.id, model: row.modelRef, provider: provider.slug};
  const backoffUntil = providerBackoff?.get(provider.slug);
  if (backoffUntil) {
    await db.update(modelCandidates).set({nextCheckAt: new Date(backoffUntil), updatedAt: new Date()}).where(eq(modelCandidates.id, row.id));
    return {...base, status: "rate_limited", httpStatus: 429, error: "Provider rate limit reached earlier in this run; retry deferred", nextCheckAt: backoffUntil};
  }
  const credential = context.credentials.get(provider.id) ?? null;
  const result = await verifyCandidateDirectly({
    modelRef: row.modelRef, source: row.source, provider: definitionForProvider(provider),
    providerBaseUrl: endpointBaseHint(provider.slug, provider.baseUrl, context.offerBaseUrls.get(provider.id) ?? null), credential,
  });

  // The world changed between reconciling blockers and this call (a key was removed): record the blocker, not a check.
  const blocker = BLOCKER_OF_NON_CALL[result.status];
  if (blocker) {
    await db.update(modelCandidates).set({checkBlocker: blocker, updatedAt: new Date()}).where(eq(modelCandidates.id, row.id));
    return {...base, status: result.status, httpStatus: null, error: result.error, nextCheckAt: null};
  }
  const outcome = result.status as CheckOutcome;
  // A real completions call failing with 401/403 is stronger, more current evidence than whatever set `valid` true earlier (a
  // manual "Test credential" from before the key was revoked or rotated) — invalidate it now rather than leave the provider
  // page showing VERIFIED until someone happens to click "Test credential" again.
  if (outcome === "auth_error" && credential) await db.update(providerCredentialReferences).set({valid: false, lastValidatedAt: new Date(), updatedAt: new Date()}).where(eq(providerCredentialReferences.id, credential.id));

  const kind = effectiveFreeKind(row.freeType, context.offerFreeTypes.get(provider.id));
  const transition = applyCheckOutcome(
    {consecutivePasses: row.consecutivePasses, everFailed: row.everFailed, lastPassedAt: row.lastPassedAt}, outcome,
    {kind, alreadyInLiteLLM: context.live.has(liveKey(provider.id, row.modelKey))},
  );
  await db.update(modelCandidates).set({
    lastCheckStatus: transition.lastCheckStatus, lastCheckedAt: transition.lastCheckedAt, lastPassedAt: transition.lastPassedAt,
    consecutivePasses: transition.consecutivePasses, everFailed: transition.everFailed, nextCheckAt: transition.nextCheckAt, checkBlocker: null, updatedAt: new Date(),
  }).where(eq(modelCandidates.id, row.id));
  await db.insert(candidateChecks).values({candidateId: row.id, status: outcome, httpStatus: result.httpStatus, error: result.error?.slice(0, 500) ?? null});
  if ((outcome === "rate_limited") && providerBackoff) providerBackoff.set(provider.slug, transition.nextCheckAt.toISOString());
  if (autoAdd && outcome === "available") await autoAddIfEligible(db, {...row, consecutivePasses: transition.consecutivePasses}, transition.consecutivePasses, context);
  return {...base, status: outcome, httpStatus: result.httpStatus, error: result.error, nextCheckAt: transition.nextCheckAt.toISOString()};
}

/** Runs `work` for every id with at most `concurrency` in flight. */
async function runAll(rows: Candidate[], concurrency: number, work: (row: Candidate) => Promise<VerificationRow | null>): Promise<VerificationRow[]> {
  const results: VerificationRow[] = [];
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(Math.max(concurrency, 1), rows.length || 1)}, async () => {
    while (cursor < rows.length) { const result = await work(rows[cursor++]!); if (result) results.push(result); }
  }));
  return results;
}

/** Candidates that are due, chosen in SQL: testable (no blocker), at a provider that has not been switched off, and past their
 *  next-check time. Ranked within each provider and then interleaved, so a provider with thousands of models cannot crowd every
 *  other provider out of a run, and a 429 from one is felt by one. Never loads more than `limit` rows. */
async function selectDue(db: ReturnType<typeof getDb>, limit: number): Promise<Candidate[]> {
  const ids = await db.execute(sql`
    select id from (
      select c.id, c.next_check_at,
        row_number() over (partition by c.provider_id order by coalesce(c.next_check_at, 'epoch'::timestamptz), c.id) as rn
      from model_candidates c join providers p on p.id = c.provider_id and p.enabled
      where c.check_blocker is null and (c.next_check_at is null or c.next_check_at <= now())
    ) due order by rn, coalesce(next_check_at, 'epoch'::timestamptz), id limit ${limit}
  `) as unknown as Array<{id: string}>;
  return loadInOrder(db, ids.map(row => row.id));
}

async function loadInOrder(db: ReturnType<typeof getDb>, ids: string[]): Promise<Candidate[]> {
  if (!ids.length) return [];
  const rows = await db.select().from(modelCandidates).where(inArray(modelCandidates.id, ids));
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => byId.get(id)).filter((row): row is Candidate => Boolean(row));
}

/** Tests candidates directly; a 429 backs off only that provider, never the whole batch. limit/concurrency default high
 *  enough to cycle through the whole testable population within a reasonable number of cron firings. */
export async function verifyDueCandidates(limit = 300, concurrency = 8) {
  const db = getDb();
  await reconcileCheckBlockers(db);
  const [context, {autoAdd}, due] = await Promise.all([loadContext(db), getLiteLLMManagementSettings(), selectDue(db, limit)]);
  const providerBackoff = new Map<string, string>();
  const results = await runAll(due, concurrency, row => checkCandidate(db, row, context, providerBackoff, autoAdd));
  return {processed: results.length, results, nextEligibleAt: results.find(item => item.status === "rate_limited")?.nextCheckAt ?? null};
}

/** Manual "test my models now": every testable candidate gets a real request, ignoring the recheck schedule and per-provider
 *  backoff, longest-untested first. It used to stop at the first 250 alphabetically, so with 800+ connected candidates the
 *  same 250 were retested on every click and the rest never were. */
export async function verifyConnectedCandidates(limit = 5000, concurrency = 10) {
  const db = getDb();
  await reconcileCheckBlockers(db);
  const ids = await db.execute(sql`
    select c.id from model_candidates c join providers p on p.id = c.provider_id and p.enabled
    where c.check_blocker is null order by c.last_checked_at asc nulls first, c.id limit ${limit}
  `) as unknown as Array<{id: string}>;
  const [context, {autoAdd}, targets] = await Promise.all([loadContext(db), getLiteLLMManagementSettings(), loadInOrder(db, ids.map(row => row.id))]);
  const results = await runAll(targets, concurrency, row => checkCandidate(db, row, context, null, autoAdd));
  const count = (status: string) => results.filter(item => item.status === status).length;
  return {processed: results.length, targeted: targets.length, available: count("available"), rateLimited: count("rate_limited"), outOfCredits: count("out_of_credits"), unavailable: count("unavailable") + count("auth_error")};
}


import "server-only";
import { candidateOnlyBlockReason } from "@/server/discovery/promotion-gate";
import { liveLaneMember } from "@/server/lanes/membership";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { canonicalModels, laneAssignments, lanes, modelCandidates, modelDeployments, providers, providerCredentialReferences, rateLimitProfiles, smokeTests, syncRuns } from "./db/schema";
import { providerDefinitionBySlug, providerSlug, resolveProvider } from "./providers/catalog";
import { matchDeployment, matchDeployments } from "./discovery/model-key";
import { resolveVerificationEndpoint } from "./discovery/verify";
import { isFlapLimited, removalHistoryOf, unprovenCheckReason } from "./discovery/auto-add-policy";
import { nonChatModelReason } from "./discovery/model-type";
import { providerWiring, CUSTOM_ADAPTER_PROVIDERS } from "./providers/wiring";
import { sourceRegistry } from "./discovery/registry";
import { laneStatus, type LaneStatus } from "./status";
import { historyTimestamp } from "@/lib/utils";

export interface ProviderRow { id: string; slug: string; name: string; status: string; adapterCapability: string; modelCount: number; healthyCount: number; knownCount: number; verifiedCount: number; credentialConfigured: boolean; credentialVerified?: boolean; enabled?: boolean; credentialState?: string; lastDiscoveryAt: Date | null; availability: string; sourceLastSync: Date | null }
export interface ProviderSourceBreakdown { source: string; tier: string; count: number }
export interface DeploymentRow { id: string; slug: string; modelName: string; providerModelId: string; litellmModelName: string; litellmDeploymentId: string | null; providerName: string; managed: boolean; health: string; lifecycle?: string; owner?: string | null; credentialFingerprint?: string | null; managedBy?: string | null; curatorVersion?: string | null; firstSeenAt?: Date; lastSeenAt?: Date; score: number | null; freeType: string; contextWindow: number | null; rpmLimit: number | null; tpmLimit: number | null; safeRpm: number | null; safeTpm: number | null; confidence: string; lastTestedAt: Date | null; benchmarkRunCount: number; lastBenchmarkStatus: string | null; apiBase?: string | null; backend?: string | null; host?: string | null; rateLimitProfileId: string | null; observedRpm: number | null; observedTpm: number | null; manualRpm: number | null; manualTpm: number | null; lastProbeAt: Date | null; avgLatencyMs: number | null; avgFirstTokenMs: number | null; latencySampleCount: number }
export interface LaneSummary { id: string; slug: string; name: string; enabled: boolean; healthy: number; total: number; minimumHealthy: number; status: LaneStatus; confidence: string }
export interface RunRow { id: string; type: string; status: string; createdAt: Date; durationMs: number | null; summary: Record<string, unknown> }
export interface DashboardData {
  demo: boolean;
  systems: { curator: string; database: string; litellm: string };
  kpis: { providers: number; models: number; active: number; healthy: number; quarantined: number; coverage: number; errors429: number; pendingChanges: number };
  lanes: LaneSummary[]; providers: ProviderRow[]; runs: RunRow[];
  incidents: Array<{ severity: string; title: string; detail: string; at: Date }>;
}

export async function getProviders(): Promise<ProviderRow[]> {
  const db = getDb();
  const rows = await db.select({
    id: providers.id, slug: providers.slug, name: providers.name, status: providers.status, adapterCapability: providers.adapterCapability,
    enabled: providers.enabled, modelCount: sql<number>`count(distinct ${modelDeployments.id})::int`,
    healthyCount: sql<number>`count(distinct ${modelDeployments.id}) filter (where ${modelDeployments.health} = 'HEALTHY')`,
    // "Known" and "verified" cover the discovery pipeline upstream of promotion — a provider can have real, discovered
    // leads sitting here well before (or instead of) anything reaching modelDeployments, which is what previously
    // made "0 models" indistinguishable between "nothing known" and "known but never promoted".
    knownCount: sql<number>`count(distinct ${modelCandidates.id})::int`,
    verifiedCount: sql<number>`count(distinct ${modelCandidates.id}) filter (where ${modelCandidates.verifiedFree} = true)::int`,
    credentialConfigured: sql<boolean>`count(${providerCredentialReferences.id}) filter (where ${providerCredentialReferences.disabled} = false) > 0`,credentialVerified:sql<boolean>`coalesce(bool_or(${providerCredentialReferences.valid}) filter (where ${providerCredentialReferences.disabled} = false),false)`, lastDiscoveryAt: providers.lastDiscoveryAt,
    // Availability: derived from credential verification + linked discovery source health.
    sourceHealth: sql<string | null>`(select ms.status::text from model_sources ms where ms.provider_id = ${providers.id} order by ms.last_sync_at desc limit 1)`,
    sourceLastSync: sql<Date | null>`(select ms.last_sync_at from model_sources ms where ms.provider_id = ${providers.id} order by ms.last_sync_at desc limit 1)`,
  }).from(providers).leftJoin(modelDeployments, eq(providers.id, modelDeployments.providerId)).leftJoin(providerCredentialReferences, eq(providers.id, providerCredentialReferences.providerId)).leftJoin(modelCandidates, eq(providers.id, modelCandidates.providerId)).groupBy(providers.id).orderBy(providers.name);
  const refs = await db.select().from(providerCredentialReferences);
  return rows.map(row => {
    const available = refs.filter(ref => ref.providerId === row.id && !ref.disabled && (ref.encryptedValue || process.env[ref.environmentVariable]));
    const credentialState = !available.length ? "MISSING" : available.some(ref => ref.valid === true) ? "CONFIGURED" : available.some(ref => ref.valid === false) ? "INVALID" : "UNKNOWN";
    let availability: "verified" | "configured" | "discovering" | "no_credential" | "failed" | "blocked" | "unknown";
    if (available.some(ref => ref.valid === true)) {
      availability = "verified";
    } else if (row.sourceHealth === "HEALTHY") {
      availability = "discovering";
    } else if (row.sourceHealth === "DEGRADED") {
      availability = "discovering";
    } else if (row.sourceHealth === "FAILED") {
      availability = "failed";
    } else if (row.sourceHealth === "BLOCKED") {
      availability = "blocked";
    } else if (credentialState === "CONFIGURED") {
      availability = "configured";
    } else if (credentialState === "MISSING") {
      availability = "no_credential";
    } else {
      availability = "unknown";
    }
    return {...row, healthyCount: Number(row.healthyCount), credentialConfigured: available.length > 0, credentialVerified: available.some(ref => ref.valid === true), credentialState, availability, sourceLastSync: row.sourceLastSync};
  });
}

const tierRank: Record<string, number> = {A1: 0, A2: 1, B: 2, C: 3};

/** Per-provider breakdown of which discovery sources (and their trust tier) contributed its known candidates —
 *  the provenance the Providers page surfaces so "0 live" is legible as "nothing known" vs. "known, stuck upstream". */
export async function getProviderSourceBreakdown(): Promise<Map<string, ProviderSourceBreakdown[]>> {
  const rows = await getDb().select({providerId: modelCandidates.providerId, source: modelCandidates.source, count: sql<number>`count(*)::int`})
    .from(modelCandidates).where(isNotNull(modelCandidates.providerId)).groupBy(modelCandidates.providerId, modelCandidates.source);
  const map = new Map<string, ProviderSourceBreakdown[]>();
  for (const row of rows) {
    if (!row.providerId) continue;
    const list = map.get(row.providerId) ?? [];
    const source = sourceRegistry.find(item => item.id === row.source);
    list.push({source: source?.name ?? row.source, tier: source?.tier ?? "C", count: row.count});
    map.set(row.providerId, list);
  }
  for (const list of map.values()) list.sort((a, b) => (tierRank[a.tier] ?? 4) - (tierRank[b.tier] ?? 4) || b.count - a.count);
  return map;
}

export async function getProvider(id: string) {
  const db=getDb(); const provider=(await db.select().from(providers).where(eq(providers.id,id)).limit(1))[0];
  if(!provider)return null;
  const credentials=await db.select({environmentVariable:providerCredentialReferences.environmentVariable,/* the stored hint is never sent to the page: only whether a value is stored */stored:sql<boolean>`${providerCredentialReferences.encryptedValue} is not null`,valid:providerCredentialReferences.valid,lastValidatedAt:providerCredentialReferences.lastValidatedAt,config:providerCredentialReferences.config}).from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId,id));
  const deployments=await getDeployments();
  return {provider,credentials,deployments:deployments.filter(item=>item.providerName===provider.name)};
}

// How many recent PASSED checks the LiteLLM page's response-time columns average over — enough to smooth out one
// slow/fast outlier without the number going stale for minutes given the health monitor's cadence (hourly by default).
const LATENCY_SAMPLE_SIZE = 10;

export async function getDeployments(onlyId?: string): Promise<DeploymentRow[]> {
  const rows = await getDb().select({
    id: modelDeployments.id, slug: canonicalModels.slug, modelName: canonicalModels.name, providerModelId: modelDeployments.providerModelId,
    litellmModelName: modelDeployments.litellmModelName, litellmDeploymentId: modelDeployments.litellmDeploymentId, providerName: providers.name, managed: modelDeployments.managed,
    lifecycle: modelDeployments.lifecycle, managedBy: modelDeployments.managedBy, curatorVersion: modelDeployments.curatorVersion, firstSeenAt: modelDeployments.createdAt, lastSeenAt: modelDeployments.lastSeenAt,
    health: modelDeployments.health, score: modelDeployments.score, freeType: modelDeployments.freeType, contextWindow: canonicalModels.contextWindow,
    rpmLimit: rateLimitProfiles.rpmLimit, tpmLimit: rateLimitProfiles.tpmLimit, safeRpm: rateLimitProfiles.safeRpm, safeTpm: rateLimitProfiles.safeTpm,
    confidence: rateLimitProfiles.confidence, lastTestedAt: modelDeployments.lastTestedAt,
    rateLimitProfileId: rateLimitProfiles.id, observedRpm: rateLimitProfiles.observedRpm, observedTpm: rateLimitProfiles.observedTpm,
    manualRpm: rateLimitProfiles.manualRpm, manualTpm: rateLimitProfiles.manualTpm, lastProbeAt: rateLimitProfiles.lastProbeAt,
    benchmarkRunCount: sql<number>`(select count(*)::int from smoke_tests where smoke_tests.deployment_id = ${modelDeployments.id})`,
    lastBenchmarkStatus: sql<string | null>`(select status::text from smoke_tests where smoke_tests.deployment_id = ${modelDeployments.id} order by created_at desc limit 1)`,
    // Averaged over the last LATENCY_SAMPLE_SIZE PASSED checks only — a failed check's latency (a fast 401, a
    // 30s timeout) says nothing about how fast the model actually responds, and first_token_ms is never even
    // recorded for one (see HttpLiteLLMAdapter.smokeTest).
    avgLatencyMs: sql<number | null>`(select round(avg(recent.latency_ms))::int from (select latency_ms from smoke_tests where smoke_tests.deployment_id = ${modelDeployments.id} and status = 'PASSED' order by created_at desc limit ${LATENCY_SAMPLE_SIZE}) recent)`,
    avgFirstTokenMs: sql<number | null>`(select round(avg(recent.first_token_ms))::int from (select first_token_ms from smoke_tests where smoke_tests.deployment_id = ${modelDeployments.id} and status = 'PASSED' order by created_at desc limit ${LATENCY_SAMPLE_SIZE}) recent)`,
    latencySampleCount: sql<number>`(select count(*)::int from (select 1 from smoke_tests where smoke_tests.deployment_id = ${modelDeployments.id} and status = 'PASSED' order by created_at desc limit ${LATENCY_SAMPLE_SIZE}) recent)`,
    apiBase:modelDeployments.apiBase,rawMetadata:modelDeployments.rawMetadata,
  }).from(modelDeployments).innerJoin(canonicalModels, eq(modelDeployments.canonicalModelId, canonicalModels.id)).innerJoin(providers, eq(modelDeployments.providerId, providers.id)).leftJoin(rateLimitProfiles, eq(modelDeployments.id, rateLimitProfiles.deploymentId)).where(onlyId ? eq(modelDeployments.id, onlyId) : undefined).orderBy(desc(modelDeployments.managed), providers.name, canonicalModels.name);
  return rows.map(({rawMetadata,...row}) => {const info=rawMetadata&&typeof rawMetadata.model_info==="object"?rawMetadata.model_info as Record<string,unknown>:{};return {...row,confidence:row.confidence??"UNKNOWN",backend:typeof info.backend==="string"?info.backend:null,host:typeof info.host==="string"?info.host:null,owner:typeof info.managed_by==="string"?info.managed_by:null,credentialFingerprint:typeof info.ratllm_credential_fingerprint==="string"?info.ratllm_credential_fingerprint:null};});
}

export async function getDeployment(id: string) {
  // Filtered in SQL: this used to load every deployment (with its per-row aggregate subqueries) just to pick one.
  return (await getDeployments(id))[0] ?? null;
}

export interface SourceYield { source: string; discovered: number; verifiedFree: number; promoted: number; providers: string[] }

/** Per-source track record — how many candidates it ever surfaced, how many turned out verified-free, how many
 *  reached a live LiteLLM deployment, and which providers it actually touched. Turns each discovery source's tier
 *  (an editorial trust claim) into a measured outcome, and lets the Providers page show provenance back to here. */
export async function getSourceYield(): Promise<Map<string, SourceYield>> {
  const db=getDb();
  const [rows,providerRows,deploymentRows]=await Promise.all([
    db.select({source:modelCandidates.source,providerId:modelCandidates.providerId,providerName:modelCandidates.providerName,modelRef:modelCandidates.modelRef,verifiedFree:modelCandidates.verifiedFree}).from(modelCandidates),
    db.select({id:providers.id,name:providers.name}).from(providers),
    db.select({id:modelDeployments.id,providerId:modelDeployments.providerId,providerModelId:modelDeployments.providerModelId,health:modelDeployments.health,managed:modelDeployments.managed,litellmModelName:modelDeployments.litellmModelName,lifecycle:modelDeployments.lifecycle}).from(modelDeployments),
  ]);
  const providerNameById=new Map(providerRows.map(p=>[p.id,p.name]));
  const working=new Map<string,SourceYield&{providerSet:Set<string>}>();
  for(const row of rows){
    const entry=working.get(row.source)??{source:row.source,discovered:0,verifiedFree:0,promoted:0,providers:[],providerSet:new Set<string>()};
    entry.discovered++;
    if(row.verifiedFree)entry.verifiedFree++;
    // A deployment that's since been deactivated/removed in LiteLLM isn't a durable "promoted" outcome any more —
    // counting it would make this measured track record just as stale as the editorial tier claims it replaced.
    if(row.providerId&&matchDeployments(deploymentRows,row.providerId,row.modelRef).some(item=>item.lifecycle==="ACTIVE"))entry.promoted++;
    const name=row.providerId?providerNameById.get(row.providerId):row.providerName??undefined;
    if(name)entry.providerSet.add(name);
    working.set(row.source,entry);
  }
  const result=new Map<string,SourceYield>();
  for(const[key,value]of working)result.set(key,{source:value.source,discovered:value.discovered,verifiedFree:value.verifiedFree,promoted:value.promoted,providers:[...value.providerSet].sort()});
  return result;
}

export interface SourceHistoryPoint { at: string; status: "succeeded" | "failed"; detail: string }

/** Per-source outcome across recent MODEL_DISCOVERY runs, mined from each run's own summary.sources array — the
 *  only place a built-in source's pass/fail is recorded run-over-run (model_sources itself only ever keeps the
 *  latest status). Without this, the Free Model Sources "History" strip had at most one real point to show, ever,
 *  no matter how many times discovery had actually run — everything else was grey "not run yet" padding. */
export async function getSourceRunHistory(limit = 30): Promise<Map<string, SourceHistoryPoint[]>> {
  const runs = await getDb().select({ summary: syncRuns.summary, createdAt: syncRuns.createdAt }).from(syncRuns)
    .where(eq(syncRuns.type, "MODEL_DISCOVERY")).orderBy(desc(syncRuns.createdAt)).limit(limit);
  const bySource = new Map<string, SourceHistoryPoint[]>();
  for (const run of runs) {
    const sources = Array.isArray(run.summary.sources) ? run.summary.sources as Array<Record<string, unknown>> : [];
    for (const entry of sources) {
      if (typeof entry.source !== "string") continue;
      const status: SourceHistoryPoint["status"] = entry.status === "succeeded" ? "succeeded" : "failed";
      const detail = typeof entry.count === "number" ? `${entry.count} found` : typeof entry.error === "string" ? entry.error : "";
      const list = bySource.get(entry.source) ?? [];
      list.push({ at: run.createdAt.toISOString(), status, detail });
      bySource.set(entry.source, list);
    }
  }
  return bySource;
}

export async function getModelCandidates(){
  const db=getDb();const [rows,providerRows,credentialRows,deploymentRows,laneRows]=await Promise.all([
    db.select().from(modelCandidates).orderBy(desc(modelCandidates.verifiedFree),modelCandidates.source,modelCandidates.displayName),
    db.select({id:providers.id,slug:providers.slug,name:providers.name,baseUrl:providers.baseUrl}).from(providers),
    db.select({providerId:providerCredentialReferences.providerId,valid:providerCredentialReferences.valid}).from(providerCredentialReferences),
    db.select({id:modelDeployments.id,providerId:modelDeployments.providerId,providerModelId:modelDeployments.providerModelId,health:modelDeployments.health,managed:modelDeployments.managed,litellmModelName:modelDeployments.litellmModelName,litellmDeploymentId:modelDeployments.litellmDeploymentId,lifecycle:modelDeployments.lifecycle,rawMetadata:modelDeployments.rawMetadata}).from(modelDeployments),
    db.select({deploymentId:laneAssignments.deploymentId,slug:lanes.slug,excluded:laneAssignments.excluded}).from(laneAssignments).innerJoin(lanes,eq(laneAssignments.laneId,lanes.id)),
  ]);
  return rows.map(row=>{
    // providerId is resolved and stored at write time (runDiscovery/consolidateModelCandidates); only fall back to
    // re-guessing from text here for rows a backfill pass hasn't reached yet (self-heals on the next discovery run).
    const provider=row.providerId
      ? providerRows.find(item=>item.id===row.providerId)
      : (() => {const slug=row.source==="openrouter"?"openrouter":providerSlug(row.providerName,row.modelRef);return providerRows.find(item=>item.slug===slug||item.name.toLowerCase()===String(row.providerName??"").toLowerCase());})();
    const credentials=provider?credentialRows.filter(item=>item.providerId===provider.id):[];
    const credentialVerified=credentials.some(item=>item.valid===true);
    // Some providers (llm7, Pollinations, Kilo) are confirmed reachable with zero credential — a missing/unverified
    // key there isn't a real blocker, so promotion shouldn't gate on it the way it does for everyone else.
    const wiring=provider?providerWiring[provider.slug]:undefined;
    const credentialRequired=Boolean(wiring?.check)&&!wiring?.credentialOptional;
    const deployments=provider?matchDeployments(deploymentRows,provider.id,row.modelRef):[];
    const deployment=provider?matchDeployment(deploymentRows,provider.id,row.modelRef):null;
    const deploymentIds=new Set(deployments.map(item=>item.id));
    const laneMemberships=laneRows.filter(lane=>!lane.excluded&&deploymentIds.has(lane.deploymentId)).map(lane=>({slug:lane.slug,health:deployments.find(item=>item.id===lane.deploymentId)?.health??"UNKNOWN"}));
    const definition=resolveProvider(row.source==="openrouter"?"openrouter":row.providerName,row.modelRef)??providerDefinitionBySlug(provider?.slug);
    const endpoint=definition?resolveVerificationEndpoint(definition,provider?.baseUrl??null):null;
    const promotableReason=candidateOnlyBlockReason(row)??(!provider?"Provider not resolved"
      :CUSTOM_ADAPTER_PROVIDERS[provider.slug]??(nonChatModelReason({modelRef:row.modelRef,displayName:row.displayName,description:typeof row.evidence?.description==="string"?row.evidence.description:null})??(credentialRequired&&!credentialVerified?"Credential not verified":!endpoint?"No known endpoint for this provider":unprovenCheckReason(row.evidence))));
    // liteLLMDeploymentId means "currently live in LiteLLM" (the real router id, gated on ACTIVE) — never just
    // "a deployment row exists for this candidate". matchDeployment() deliberately falls back to a stale
    // REMOVED/DEACTIVATED row so liteLLMLifecycle can still show real history, but that same stale row must never
    // read as "added" here — autoAddIfEligible (verify-due.ts) uses this exact field to decide whether a
    // recovered candidate is eligible to be auto-re-added, and a permanently-truthy id would block that forever.
    const liveLiteLLMDeploymentId=deployment?.lifecycle==="ACTIVE"?deployment.litellmDeploymentId??null:null;
    // Distinguishes an auto-remove (health/monitor.ts always stamps a removedReason) from a plain manual delete
    // (never does) so the UI can tell "automation pulled this, might come back" from "someone deleted this on
    // purpose" — see docs/FREE-MODEL-LIFECYCLE.md §3.
    const liteLLMRemovedReason=deployment?.lifecycle==="REMOVED"&&typeof deployment.rawMetadata?.removedReason==="string"?deployment.rawMetadata.removedReason:null;
    const liteLLMNeedsReview=isFlapLimited(removalHistoryOf(row.evidence));
    return {...row,providerId:provider?.id??null,credentialConfigured:credentials.length>0,credentialVerified,credentialRequired,liteLLMDeploymentId:liveLiteLLMDeploymentId,liteLLMHealth:deployment?.health??null,liteLLMManaged:deployment?.managed??null,liteLLMLifecycle:deployment?.lifecycle??null,liteLLMRemovedReason,liteLLMNeedsReview,laneMemberships,promotable:promotableReason===null,promotableReason};
  });
}

export interface CandidateCheckPoint { at: Date; status: string; httpStatus: number | null; error: string | null }

/** Recent per-candidate availability-check history for uptime strips.
 *
 *  Ranked per candidate in SQL (the same row_number() shape getBenchmarkStats uses) rather than by taking the newest
 *  N rows table-wide and bucketing them in memory. That older approach silently starved every row once the table
 *  outgrew its global cap: candidate verification writes ~5.4k checks/day across ~2.3k candidates, so a 4,000-row
 *  window held barely a day and a half of history no matter how much was actually stored — every uptime strip on
 *  the Discovered Models page collapsed to one or two bars while 15+ days of checks sat unread in the table.
 *  A per-candidate window can't degrade that way: each candidate gets its own newest `perCandidate` rows, so what
 *  the strip shows depends only on what was recorded for that candidate, never on how many other candidates exist. */
export async function getCandidateCheckHistory(perCandidate = 30): Promise<Map<string, CandidateCheckPoint[]>> {
  const rows = await getDb().execute(sql`
    with ranked as (
      select candidate_id, created_at, status, http_status, error,
        row_number() over (partition by candidate_id order by created_at desc) as rn
      from candidate_checks
    )
    select candidate_id as "candidateId", created_at as "at", status, http_status as "httpStatus", error
    from ranked where rn <= ${perCandidate} order by candidate_id, created_at desc
  `) as unknown as Array<Omit<CandidateCheckPoint,"at"> & { at: Date | string; candidateId: string }>;
  const byCandidate = new Map<string, CandidateCheckPoint[]>();
  for (const { candidateId, ...point } of rows) {
    const list = byCandidate.get(candidateId) ?? [];
    list.push({...point, at: historyTimestamp(point.at)});
    byCandidate.set(candidateId, list);
  }
  return byCandidate;
}

/** When each candidate's direct availability check last actually passed. Separate from getCandidateCheckHistory on
 *  purpose: that one is a bounded window for drawing bars, so a candidate that passed 3 weeks ago and has failed every
 *  check since would have no pass in its window at all. One grouped scan over candidate_checks (~40k rows). */
export async function getCandidateLastPassed(): Promise<Map<string, Date>> {
  const rows = await getDb().execute(sql`
    select candidate_id as "candidateId", max(created_at) as "at"
    from candidate_checks where status = 'available' group by candidate_id
  `) as unknown as Array<{ candidateId: string; at: Date | string }>;
  return new Map(rows.map(row => [row.candidateId, historyTimestamp(row.at)]));
}

export async function getLanes(): Promise<LaneSummary[]> {
  const db = getDb();
  const rows = await db.select({
    id: lanes.id, slug: lanes.slug, name: lanes.name, enabled: lanes.enabled, minimumHealthy: lanes.minimumHealthy,
    // Live members only (see lanes/membership.ts): assignments left behind by removed or blocked deployments don't count.
    total: sql<number>`count(${laneAssignments.id}) filter (where ${liveLaneMember})`,
    healthy: sql<number>`count(${laneAssignments.id}) filter (where ${liveLaneMember} and ${modelDeployments.health} = 'HEALTHY')`,
  }).from(lanes)
    .leftJoin(laneAssignments, eq(lanes.id, laneAssignments.laneId))
    .leftJoin(modelDeployments, eq(laneAssignments.deploymentId, modelDeployments.id))
    .groupBy(lanes.id)
    .orderBy(lanes.slug);
  return rows.map(row => {
    const total = Number(row.total);
    const healthy = Number(row.healthy);
    const status = laneStatus({ enabled: row.enabled, healthy, total, minimumHealthy: row.minimumHealthy });
    return { ...row, total, healthy, status, confidence: status === "HEALTHY" ? "HIGH" : "UNKNOWN" };
  });
}

export async function getRuns(options: {type?: string; limit?: number; offset?: number} = {}): Promise<RunRow[]> {
  const query = getDb().select().from(syncRuns);
  const rows = await (options.type ? query.where(eq(syncRuns.type, options.type)) : query).orderBy(desc(syncRuns.createdAt)).limit(options.limit ?? 12).offset(options.offset ?? 0);
  return rows.map(row => ({ id: row.id, type: row.type, status: row.status, createdAt: row.createdAt, durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null, summary: row.summary }));
}

export async function getRunsCount(type?: string): Promise<number> {
  const query = getDb().select({ value: sql<number>`count(*)` }).from(syncRuns);
  const rows = await (type ? query.where(eq(syncRuns.type, type)) : query);
  return Number(rows[0]?.value ?? 0);
}

/**
 * The last `perType` runs of each given type, so a high-frequency job (LANE_RECONCILE, LITELLM_SYNC) can't starve a
 * daily job out of the shared run history the settings page renders. One indexed query per type — cheap for ~10 types.
 */
export async function getRunHistoryByType(types: readonly string[], perType = 20): Promise<Record<string, RunRow[]>> {
  const db = getDb();
  const lists = await Promise.all(types.map(type =>
    db.select().from(syncRuns).where(eq(syncRuns.type, type)).orderBy(desc(syncRuns.createdAt)).limit(perType)
  ));
  return Object.fromEntries(types.map((type, index) => [type, lists[index].map(row => ({
    id: row.id, type: row.type, status: row.status, createdAt: row.createdAt,
    durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null, summary: row.summary,
  }))]));
}

export interface SourceCheckPoint { at: Date; status: string; httpStatus: number | null; error: string | null; discoveredCount: number | null }

/**
 * Recent per-provider discovery source check history for trend indicators.
 * One query, grouped in memory. Falls back to deployment smoke history when a
 * provider has no discovery source yet.
 */
export async function getProviderSourceCheckHistory(perProvider = 30): Promise<Map<string, SourceCheckPoint[]>> {
  const rows = await getDb().execute(sql`
    with ranked as (
      select provider_id, created_at, status, http_status, error, discovered_count,
        row_number() over (partition by provider_id order by created_at desc) as rn
      from source_checks where provider_id is not null
    )
    select provider_id as "providerId", created_at as "at", status, http_status as "httpStatus",
      error, discovered_count as "discoveredCount"
    from ranked where rn <= ${perProvider} order by provider_id, created_at desc
  `) as unknown as Array<Omit<SourceCheckPoint,"at"> & { at: Date | string; providerId: string }>;
  const byProvider = new Map<string, SourceCheckPoint[]>();
  for (const { providerId, ...point } of rows) {
    const list = byProvider.get(providerId) ?? [];
    list.push({...point, at: historyTimestamp(point.at)});
    byProvider.set(providerId, list);
  }
  return byProvider;
}

export async function getSmokeTests(limit = 20) {
  return getDb().select().from(smokeTests).orderBy(desc(smokeTests.createdAt)).limit(limit);
}

export interface BenchmarkStat { deploymentId: string; samples: number; successRate: number; p50LatencyMs: number | null; p95LatencyMs: number | null; avgFirstTokenMs: number | null }

/** Success rate and latency percentiles per deployment over its most recent `window` smoke tests. */
export async function getBenchmarkStats(window = 20): Promise<Map<string, BenchmarkStat>> {
  const rows = await getDb().execute(sql`
    with ranked as (
      select deployment_id, status, latency_ms, first_token_ms,
        row_number() over (partition by deployment_id order by created_at desc) as rn
      from smoke_tests where deployment_id is not null
    )
    select deployment_id as "deploymentId",
      count(*)::int as samples,
      round(100.0 * count(*) filter (where status = 'PASSED') / count(*), 1)::float as "successRate",
      percentile_cont(0.5) within group (order by latency_ms)::int as "p50LatencyMs",
      percentile_cont(0.95) within group (order by latency_ms)::int as "p95LatencyMs",
      round(avg(first_token_ms) filter (where first_token_ms is not null))::int as "avgFirstTokenMs"
    from ranked where rn <= ${window}
    group by deployment_id
  `);
  const stats = rows as unknown as BenchmarkStat[];
  return new Map(stats.map(row => [row.deploymentId, row]));
}

export interface SmokeHistoryPoint { at: Date; status: string; httpStatus: number | null; latencyMs: number | null; error: string | null }

/** Recent per-deployment smoke-test history for uptime strips. One query, grouped in memory to avoid N+1 per row. */
export async function getDeploymentSmokeHistory(perDeployment = 30): Promise<Map<string, SmokeHistoryPoint[]>> {
  const rows = await getDb().execute(sql`
    with ranked as (
      select deployment_id, created_at, status, http_status, latency_ms, error,
        row_number() over (partition by deployment_id order by created_at desc) as rn
      from smoke_tests where deployment_id is not null
    )
    select deployment_id as "deploymentId", created_at as "at", status, http_status as "httpStatus",
      latency_ms as "latencyMs", error
    from ranked where rn <= ${perDeployment} order by deployment_id, created_at desc
  `) as unknown as Array<Omit<SmokeHistoryPoint,"at"> & { at: Date | string; deploymentId: string }>;
  const byDeployment = new Map<string, SmokeHistoryPoint[]>();
  for (const { deploymentId, ...point } of rows) {
    const list = byDeployment.get(deploymentId) ?? [];
    list.push({...point, at: historyTimestamp(point.at)});
    byDeployment.set(deploymentId, list);
  }
  return byDeployment;
}

/** Recent per-provider smoke-test history (across all of a provider's deployments) for uptime strips. */
export async function getProviderSmokeHistory(perProvider = 20): Promise<Map<string, SmokeHistoryPoint[]>> {
  const rows = await getDb().execute(sql`
    with ranked as (
      select d.provider_id, s.created_at, s.status, s.http_status, s.latency_ms, s.error,
        row_number() over (partition by d.provider_id order by s.created_at desc) as rn
      from smoke_tests s join model_deployments d on d.id = s.deployment_id
    )
    select provider_id as "providerId", created_at as "at", status, http_status as "httpStatus",
      latency_ms as "latencyMs", error
    from ranked where rn <= ${perProvider} order by provider_id, created_at desc
  `) as unknown as Array<Omit<SmokeHistoryPoint,"at"> & { at: Date | string; providerId: string }>;
  const byProvider = new Map<string, SmokeHistoryPoint[]>();
  for (const { providerId, ...point } of rows) {
    const list = byProvider.get(providerId) ?? [];
    list.push({...point, at: historyTimestamp(point.at)});
    byProvider.set(providerId, list);
  }
  return byProvider;
}

export async function getDashboard(): Promise<DashboardData> {
  const [{ demoDashboard }, { env }] = await Promise.all([import("./demo-data"), import("./config")]);
  if (env.DEMO_MODE) return demoDashboard;
  const {connectionSummary} = await import("./settings/connections");
  const [providerRows, deploymentRows, laneRows, runRows, litellm] = await Promise.all([getProviders(), getDeployments(), getLanes(), getRuns(), connectionSummary("litellm")]);
  const enabledLanes = laneRows.filter(lane => lane.enabled);
  const covered = enabledLanes.filter(lane => lane.status === "HEALTHY").length;
  const [recent429, quarantined, discovered] = await Promise.all([
    getDb().select({ value: sql<number>`count(*)` }).from(smokeTests).where(sql`${smokeTests.createdAt} >= now() - interval '24 hours' and ${smokeTests.httpStatus} = 429`),
    getDb().select({ value: sql<number>`count(*)` }).from(canonicalModels).where(eq(canonicalModels.lifecycle, "QUARANTINED")),
    getDb().select({ value: sql<number>`count(*)` }).from(modelCandidates),
  ]);
  return {
    demo: false, systems: { curator: "HEALTHY", database: "HEALTHY", litellm: litellm.status },
    kpis: { providers: providerRows.filter(row => row.credentialConfigured).length, models: Number(discovered[0]?.value ?? 0), active: deploymentRows.length, healthy: deploymentRows.filter(row => row.health === "HEALTHY").length, quarantined: Number(quarantined[0]?.value ?? 0), coverage: enabledLanes.length ? Math.round(covered / enabledLanes.length * 100) : 0, errors429: Number(recent429[0]?.value ?? 0), pendingChanges: 0 },
    lanes: laneRows, providers: providerRows, runs: runRows, incidents: [...providerRows.filter(row => row.enabled && (!row.credentialConfigured || row.status === "AUTH_FAILED")).map(row => ({severity:"WARNING",title:row.credentialConfigured ? `${row.name} authentication failed` : `${row.name} credential missing`,detail:"Review provider credentials in Settings.",at:new Date()})), ...(litellm.status === "UNAVAILABLE" ? [{severity:"WARNING",title:"LiteLLM unreachable",detail:litellm.error ?? "Test the connection in Settings.",at:new Date(litellm.lastTestAt ?? Date.now())}] : []), ...laneRows.filter(lane => lane.enabled && lane.status !== "HEALTHY").map(lane => ({ severity: "WARNING", title: `${lane.slug} ${lane.status === "UNASSIGNED" ? "has no assignments" : "is below redundancy target"}`, detail: `${lane.healthy}/${lane.minimumHealthy} healthy assigned deployments`, at: new Date() }))],
  };
}

export async function withDemo<T>(query: () => Promise<T>, demo: () => T): Promise<T> {
  const { env } = await import("./config");
  return env.DEMO_MODE ? demo() : query();
}

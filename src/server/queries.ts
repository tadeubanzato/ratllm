import "server-only";
import { candidateOnlyBlockReason, candidateOnlySources } from "@/server/discovery/promotion-gate";
import { liveLaneMember } from "@/server/lanes/membership";
import { desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { canonicalModels, laneAssignments, lanes, modelCandidates, modelDeployments, providerOffers, providers, providerCredentialReferences, rateLimitProfiles, smokeTests, syncRuns, systemSettings } from "./db/schema";
import { deploymentModelKey, matchDeployment, matchDeployments } from "./discovery/model-key";
import { isFlapLimited, removalHistoryOf } from "./discovery/auto-add-policy";
import { BLOCKER_LABELS, providerBlocker, type CheckBlocker } from "./discovery/blockers";
import { effectiveFreeKind, promotionGateReason, PROMOTION_PASSES, type FreeKind } from "./discovery/verification-policy";
import { providerWiring, CUSTOM_ADAPTER_PROVIDERS } from "./providers/wiring";
import { sourceRegistry } from "./discovery/registry";
import { laneStatus, type LaneStatus } from "./status";
import { historyTimestamp } from "@/lib/utils";

/** Where a provider stands before any model of it can be tested: derived from what is known (endpoint, credential), never stored. */
export type ProviderReadiness = "READY" | "UNVERIFIED" | "NEEDS_CREDENTIAL" | "NO_ENDPOINT";
export interface ProviderOfferSummary { freeType: string; freeTierText: string | null; rateLimitsText: string | null; expiresAt: string | null; cardRequired: boolean | null; commercialOk: boolean | null; source: string; sourceLastVerified: string | null }
export interface ProviderRow { id: string; slug: string; name: string; status: string; adapterCapability: string; modelCount: number; healthyCount: number; knownCount: number; verifiedCount: number; credentialConfigured: boolean; credentialVerified?: boolean; enabled?: boolean; credentialState?: string; lastDiscoveryAt: Date | null; availability: string; sourceLastSync: Date | null; origin?: string; passingCount?: number; readyCount?: number; readiness?: ProviderReadiness; offer?: ProviderOfferSummary | null; freeKind?: FreeKind }
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
  // The subqueries below correlate with the outer providers row. A drizzle column reference in a single-table select renders unqualified
  // ("id"), which inside a subquery silently binds to the *inner* table's own id and matches nothing, so the outer row is named explicitly.
  const outerId = sql.raw('"providers"."id"');
  // Per-provider subqueries rather than one join across deployments, credentials and candidates: that join multiplies rows
  // (candidates x deployments x credentials per provider) and its cost grows with the largest table. Each subquery here is one
  // indexed lookup, so a provider costs the same however many models exist elsewhere (docs/DISCOVERY-PIPELINE.md I12).
  const rows = await db.select({
    id: providers.id, slug: providers.slug, name: providers.name, status: providers.status, adapterCapability: providers.adapterCapability,
    enabled: providers.enabled, origin: providers.origin, baseUrl: providers.baseUrl, lastDiscoveryAt: providers.lastDiscoveryAt,
    modelCount: sql<number>`(select count(*)::int from model_deployments d where d.provider_id = ${outerId})`,
    healthyCount: sql<number>`(select count(*)::int from model_deployments d where d.provider_id = ${outerId} and d.health = 'HEALTHY')`,
    // "Known" and "verified" cover the discovery pipeline upstream of promotion — a provider can have real, discovered leads well
    // before (or instead of) anything reaching modelDeployments, which is what once made "0 models" indistinguishable between
    // "nothing known" and "known but never promoted".
    knownCount: sql<number>`(select count(*)::int from model_candidates c where c.provider_id = ${outerId})`,
    verifiedCount: sql<number>`(select count(*)::int from model_candidates c where c.provider_id = ${outerId} and c.verified_free)`,
    passingCount: sql<number>`(select count(*)::int from model_candidates c where c.provider_id = ${outerId} and c.last_check_status = 'available')`,
    readyCount: sql<number>`(select count(*)::int from model_candidates c where c.provider_id = ${outerId} and c.consecutive_passes >= ${PROMOTION_PASSES})`,
    sourceHealth: sql<string | null>`(select ms.status::text from model_sources ms where ms.provider_id = ${outerId} order by ms.last_sync_at desc limit 1)`,
    sourceLastSync: sql<Date | null>`(select ms.last_sync_at from model_sources ms where ms.provider_id = ${outerId} order by ms.last_sync_at desc limit 1)`,
  }).from(providers).orderBy(sql`(select count(*) from model_candidates c where c.provider_id = ${outerId}) desc`, providers.name);
  const [refs, offerRows] = await Promise.all([db.select().from(providerCredentialReferences), db.select().from(providerOffers)]);
  return rows.map(({ baseUrl, ...row }) => {
    const available = refs.filter(ref => ref.providerId === row.id && !ref.disabled && (ref.encryptedValue || process.env[ref.environmentVariable]));
    const credentialState = !available.length ? "MISSING" : available.some(ref => ref.valid === true) ? "CONFIGURED" : available.some(ref => ref.valid === false) ? "INVALID" : "UNKNOWN";
    const offers = offerRows.filter(offer => offer.providerId === row.id);
    const offer = offers.find(item => item.freeType !== "UNKNOWN") ?? offers[0] ?? null;
    const blocker = providerBlocker({ slug: row.slug, baseUrl, offerBaseUrl: offers.find(item => item.openaiBaseUrl)?.openaiBaseUrl ?? null, hasCredential: available.length > 0, credentialVerified: available.some(ref => ref.valid === true) });
    const readiness: ProviderReadiness = blocker === "NO_ENDPOINT" ? "NO_ENDPOINT" : blocker === "CREDENTIAL_MISSING" ? "NEEDS_CREDENTIAL" : blocker === "CREDENTIAL_UNVERIFIED" ? "UNVERIFIED" : "READY";
    let availability: "verified" | "configured" | "discovering" | "no_credential" | "failed" | "blocked" | "unknown";
    if (available.some(ref => ref.valid === true)) availability = "verified";
    else if (row.sourceHealth === "HEALTHY" || row.sourceHealth === "DEGRADED") availability = "discovering";
    else if (row.sourceHealth === "FAILED") availability = "failed";
    else if (row.sourceHealth === "BLOCKED") availability = "blocked";
    else if (credentialState === "CONFIGURED") availability = "configured";
    else if (credentialState === "MISSING") availability = "no_credential";
    else availability = "unknown";
    return {
      ...row, healthyCount: Number(row.healthyCount), credentialConfigured: available.length > 0, credentialVerified: available.some(ref => ref.valid === true), credentialState, availability, readiness,
      freeKind: effectiveFreeKind(null, offers.map(item => item.freeType)),
      offer: offer ? { freeType: offer.freeType, freeTierText: offer.freeTierText, rateLimitsText: offer.rateLimitsText, expiresAt: offer.expiresAt, cardRequired: offer.cardRequired, commercialOk: offer.commercialOk, source: offer.source, sourceLastVerified: offer.sourceLastVerified } : null,
    };
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
  // The provider's own documentation as a discovery source published it: the fallback when no key page is curated for it.
  const docsUrl=(await db.select({docsUrl:providerOffers.docsUrl}).from(providerOffers).where(eq(providerOffers.providerId,id)).orderBy(providerOffers.source)).map(row=>row.docsUrl).find(url=>Boolean(url))??null;
  return {provider,credentials,docsUrl,deployments:deployments.filter(item=>item.providerName===provider.name)};
}

// How many recent PASSED checks the LiteLLM page's response-time columns average over — enough to smooth out one
// slow/fast outlier without the number going stale for minutes given the health monitor's cadence (hourly by default).
const LATENCY_SAMPLE_SIZE = 10;

/** Deployments still in LiteLLM (live or deactivated). One that was removed is history: it is only returned when asked for by its own id, so
 *  the detail page of a removed model still works while every list and count reflects what is actually in the router. */
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
  }).from(modelDeployments).innerJoin(canonicalModels, eq(modelDeployments.canonicalModelId, canonicalModels.id)).innerJoin(providers, eq(modelDeployments.providerId, providers.id)).leftJoin(rateLimitProfiles, eq(modelDeployments.id, rateLimitProfiles.deploymentId)).where(onlyId ? eq(modelDeployments.id, onlyId) : ne(modelDeployments.lifecycle, "REMOVED")).orderBy(desc(modelDeployments.managed), providers.name, canonicalModels.name);
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
  const db = getDb();
  // One aggregate over the candidates instead of loading every row and matching deployments in memory (docs/DISCOVERY-PIPELINE.md I12).
  // "Promoted" is a candidate that is live in LiteLLM right now; the deployments table is tiny, so it becomes a literal VALUES list.
  const deploymentRows = await db.select({ providerId: modelDeployments.providerId, providerModelId: modelDeployments.providerModelId }).from(modelDeployments).where(eq(modelDeployments.lifecycle, "ACTIVE"));
  const live = pairList(deploymentRows.map(row => [row.providerId, deploymentModelKey(row.providerModelId)] as const));
  const promoted = live ? sql`(c.provider_id, c.model_key) in (${live})` : sql`false`;
  const rows = await db.execute(sql`
    select c.source, count(*)::int as discovered, (count(*) filter (where c.verified_free))::int as "verifiedFree", (count(*) filter (where ${promoted}))::int as promoted,
      coalesce(array_agg(distinct coalesce(p.name, c.provider_name)) filter (where coalesce(p.name, c.provider_name) is not null), '{}') as providers
    from model_candidates c left join providers p on p.id = c.provider_id group by c.source
  `) as unknown as Array<{ source: string; discovered: number; verifiedFree: number; promoted: number; providers: string[] }>;
  return new Map(rows.map(row => [row.source, { source: row.source, discovered: row.discovered, verifiedFree: row.verifiedFree, promoted: row.promoted, providers: [...row.providers].sort() }]));
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

// ── Discovered Models ──────────────────────────────────────────────────────────────────────────────────────────────────

export type CandidateView = "all" | "new" | "ready" | "added" | "passing" | "setup";
export const CANDIDATE_VIEWS: ReadonlyArray<{ id: CandidateView; label: string; hint: string }> = [
  { id: "all", label: "All", hint: "Every discovered model" },
  { id: "new", label: "New", hint: "Found by discovery, not in LiteLLM yet and still addable — the badge stays until it is added" },
  { id: "ready", label: "Ready to add", hint: `${PROMOTION_PASSES} passes in a row and not in LiteLLM yet` },
  { id: "added", label: "In LiteLLM", hint: "Live in LiteLLM right now" },
  { id: "passing", label: "Passing", hint: "Its latest test passed" },
  { id: "setup", label: "Needs setup", hint: "Waiting on a credential or a base URL" },
];
export interface CandidateQuery { view?: CandidateView; q?: string; provider?: string; page?: number; pageSize?: number }
export const DEFAULT_PAGE_SIZE = 100;
/** system_settings key holding the moment candidate identity changed to (source, model id, provider). Written by migration 0017. */
export const BASELINE_EPOCH_KEY = "discovery.baseline_epoch";
const SOURCE_BASELINE_MINUTES = 30;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
const pairList = (pairs: ReadonlyArray<readonly [string, string]>) => pairs.length ? sql.join(pairs.map(([providerId, key]) => sql`(${providerId}::uuid, ${key}::text)`), sql`, `) : null;

/** The rows on one page of the Discovered Models list, enriched. Everything that scales with the number of candidates happens
 *  in SQL (filtering, ordering, counting, "is this new", "who else lists it") and is paginated (docs/DISCOVERY-PIPELINE.md I12);
 *  only the rows of the page are then joined, in memory, to the small tables that do not grow with candidates: providers,
 *  credentials, offers, LiteLLM deployments and lanes. */
export async function getCandidatePage(query: CandidateQuery = {}) {
  const db = getDb();
  const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), 500);
  const view = query.view ?? "all";
  const [providerRows, credentialRows, offerRows, deploymentRows, laneRows] = await Promise.all([
    db.select({id:providers.id,slug:providers.slug,name:providers.name,baseUrl:providers.baseUrl,origin:providers.origin}).from(providers),
    db.select({providerId:providerCredentialReferences.providerId,valid:providerCredentialReferences.valid}).from(providerCredentialReferences).where(eq(providerCredentialReferences.disabled,false)),
    db.select().from(providerOffers),
    db.select({id:modelDeployments.id,providerId:modelDeployments.providerId,providerModelId:modelDeployments.providerModelId,health:modelDeployments.health,managed:modelDeployments.managed,litellmModelName:modelDeployments.litellmModelName,litellmDeploymentId:modelDeployments.litellmDeploymentId,lifecycle:modelDeployments.lifecycle,rawMetadata:modelDeployments.rawMetadata,createdAt:modelDeployments.createdAt}).from(modelDeployments),
    db.select({deploymentId:laneAssignments.deploymentId,slug:lanes.slug,excluded:laneAssignments.excluded}).from(laneAssignments).innerJoin(lanes,eq(laneAssignments.laneId,lanes.id)),
  ]);

  // (provider, model key) of every model that is in LiteLLM — in any state for "was ever added", live for "is added now". The
  // deployments table is tiny, so these become a literal VALUES list instead of a join.
  const keyOf = (row: { providerId: string; providerModelId: string }) => [row.providerId, deploymentModelKey(row.providerModelId)] as const;
  const anyPairs = pairList(deploymentRows.map(keyOf));
  const livePairs = pairList(deploymentRows.filter(row => row.lifecycle === "ACTIVE").map(keyOf));
  const inAny = anyPairs ? sql`(c.provider_id, c.model_key) in (${anyPairs})` : sql`false`;
  const inLive = livePairs ? sql`(c.provider_id, c.model_key) in (${livePairs})` : sql`false`;
  // The specification of "New" is newlyDiscoveredIds in discovery/new-candidates.ts; tests-integration/discovery-pipeline.test.ts
  // checks this SQL against it. Written once here so the badge and the "New" filter can never disagree.
  // Not a chat model, or reported only by a community list: permanently blocked, so it is not waiting for anything (see newlyDiscoveredIds).
  const communityList = candidateOnlySources.size ? sql.join([...candidateOnlySources].map(id => sql`${id}`), sql`, `) : null;
  const communityOnly = communityList
    ? sql`not (c.source in (${communityList}) and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(c.evidence->'corroboratingSources') = 'array' then c.evidence->'corroboratingSources' else '[]'::jsonb end) e where e->>'source' not in (${communityList})))`
    : sql`true`;
  const isNew = sql`(c.provider_id is not null
    and c.first_seen_at - src.first_ingest >= (${SOURCE_BASELINE_MINUTES} * interval '1 minute')
    and not exists (select 1 from model_candidates o where o.provider_id = c.provider_id and o.model_key = c.model_key and o.first_seen_at < c.first_seen_at)
    and coalesce(c.check_blocker, '') <> 'NOT_CHAT_MODEL' and (c.evidence->>'nonChatReason') is null
    and ${communityOnly}
    and not ${inAny})`;
  const viewFilter = { all: sql`true`, new: isNew, ready: sql`(c.consecutive_passes >= ${PROMOTION_PASSES} and not ${inLive})`, added: inLive,
    passing: sql`c.last_check_status = 'available'`, setup: sql`c.check_blocker in ('CREDENTIAL_MISSING', 'CREDENTIAL_UNVERIFIED', 'NO_ENDPOINT')` }[view];
  const text = query.q?.trim();
  const filters = [viewFilter,
    ...(text ? [sql`(c.display_name ilike ${`%${escapeLike(text)}%`} or c.model_ref ilike ${`%${escapeLike(text)}%`} or c.provider_name ilike ${`%${escapeLike(text)}%`})`] : []),
    ...(query.provider ? [sql`c.provider_id = (select id from providers where slug = ${query.provider})`] : [])];
  const where = sql.join(filters, sql` and `);
  // A source's baseline is its first ingest since the identity epoch when it has one, otherwise its first ingest ever (new-candidates.ts).
  const epochRow = (await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, BASELINE_EPOCH_KEY)).limit(1))[0];
  const epoch = typeof epochRow?.value === "string" && !Number.isNaN(Date.parse(epochRow.value)) ? new Date(epochRow.value).toISOString() : null;
  const withSources = sql`with src as (select source, coalesce(min(first_seen_at) filter (where first_seen_at >= ${epoch}::timestamptz), min(first_seen_at)) as first_ingest from model_candidates group by source)`;

  const countWhere = async (filter: ReturnType<typeof sql>) => Number(((await db.execute(sql`${withSources} select count(*)::int as n from model_candidates c join src on src.source = c.source where ${filter}`)) as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  const total = await countWhere(where);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), pageCount);
  const order = view === "new" ? sql`c.first_seen_at desc, c.id` : sql`c.consecutive_passes desc, c.last_passed_at desc nulls last, c.verified_free desc, c.display_name asc, c.id`;
  const pageIds = await db.execute(sql`${withSources}
    select c.id, ${isNew} as is_new,
      (select count(distinct o.provider_id)::int from model_candidates o where o.model_key = c.model_key and o.provider_id is not null and o.provider_id is distinct from c.provider_id) as also_at
    from model_candidates c join src on src.source = c.source where ${where} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`) as unknown as Array<{ id: string; is_new: boolean; also_at: number }>;
  const rows = pageIds.length ? await db.select().from(modelCandidates).where(inArray(modelCandidates.id, pageIds.map(row => row.id))) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const extra = new Map(pageIds.map(row => [row.id, row]));

  const counts = Object.fromEntries(await Promise.all((Object.keys({ all: 0, new: 0, ready: 0, added: 0, passing: 0, setup: 0 }) as CandidateView[]).map(async id => {
    const filter = { all: sql`true`, new: isNew, ready: sql`(c.consecutive_passes >= ${PROMOTION_PASSES} and not ${inLive})`, added: inLive, passing: sql`c.last_check_status = 'available'`, setup: sql`c.check_blocker in ('CREDENTIAL_MISSING', 'CREDENTIAL_UNVERIFIED', 'NO_ENDPOINT')` }[id];
    return [id, await countWhere(filter)] as const;
  }))) as Record<CandidateView, number>;

  const enriched = pageIds.map(({ id }) => byId.get(id)).filter((row): row is typeof modelCandidates.$inferSelect => Boolean(row)).map(row => {
    const provider = row.providerId ? providerRows.find(item => item.id === row.providerId) ?? null : null;
    const credentials = provider ? credentialRows.filter(item => item.providerId === provider.id) : [];
    const credentialVerified = credentials.some(item => item.valid === true);
    // Some providers (llm7, Pollinations, Kilo) are confirmed reachable with zero credential — a missing/unverified key there isn't a real blocker.
    const wiring = provider ? providerWiring[provider.slug] : undefined;
    const credentialRequired = Boolean(wiring?.check) && !wiring?.credentialOptional;
    const offers = provider ? offerRows.filter(item => item.providerId === provider.id) : [];
    const deployments = provider ? matchDeployments(deploymentRows, provider.id, row.modelRef) : [];
    const deployment = provider ? matchDeployment(deploymentRows, provider.id, row.modelRef) : null;
    const deploymentIds = new Set(deployments.map(item => item.id));
    const laneMemberships = laneRows.filter(lane => !lane.excluded && deploymentIds.has(lane.deploymentId)).map(lane => ({ slug: lane.slug, health: deployments.find(item => item.id === lane.deploymentId)?.health ?? "UNKNOWN" }));
    // liteLLMDeploymentId means "currently live in LiteLLM" (the real router id, gated on ACTIVE) — never just "a deployment row exists".
    // matchDeployment() deliberately falls back to a stale REMOVED/DEACTIVATED row so liteLLMLifecycle can still show real history, but
    // that stale row must never read as "added": autoAddIfEligible uses this to decide whether a recovered candidate may be auto-re-added.
    const liveLiteLLMDeploymentId = deployment?.lifecycle === "ACTIVE" ? deployment.litellmDeploymentId ?? null : null;
    const liteLLMRemovedReason = deployment?.lifecycle === "REMOVED" && typeof deployment.rawMetadata?.removedReason === "string" ? deployment.rawMetadata.removedReason : null;
    const liteLLMNeedsReview = isFlapLimited(removalHistoryOf(row.evidence));
    const everInLiteLLM = deployments.length > 0 || removalHistoryOf(row.evidence).length > 0 || row.addedToLitellmAt !== null;
    const blocker = row.checkBlocker as CheckBlocker | null;
    const promotableReason = candidateOnlyBlockReason(row) ?? (!provider ? "Provider not resolved" : CUSTOM_ADAPTER_PROVIDERS[provider.slug] ?? (blocker ? BLOCKER_LABELS[blocker] ?? blocker
      : promotionGateReason({ consecutivePasses: row.consecutivePasses, lastCheckStatus: row.lastCheckStatus, previouslyInLiteLLM: everInLiteLLM })));
    // "Added <date>": the stamp a promotion left, else the oldest live deployment (models added before the stamp existed).
    const liveDeployments = deployments.filter(item => item.lifecycle === "ACTIVE");
    const addedAt = liveLiteLLMDeploymentId ? row.addedToLitellmAt ?? (liveDeployments.length ? new Date(Math.min(...liveDeployments.map(item => item.createdAt.getTime()))) : null) : null;
    const meta = extra.get(row.id);
    return {
      ...row, providerId: provider?.id ?? null, providerSlug: provider?.slug ?? null, providerOrigin: provider?.origin ?? null,
      credentialConfigured: credentials.length > 0, credentialVerified, credentialRequired,
      freeKind: effectiveFreeKind(row.freeType, offers.map(offer => offer.freeType)),
      offer: offers.find(offer => offer.freeType !== "UNKNOWN") ?? offers[0] ?? null,
      liteLLMDeploymentId: liveLiteLLMDeploymentId, liteLLMHealth: deployment?.health ?? null,
      // Only a live deployment is "managed by RatLLM" right now; a removed one is history and must not show the R flag.
      liteLLMManaged: liveLiteLLMDeploymentId ? deployment?.managed ?? null : null,
      liteLLMLifecycle: deployment?.lifecycle ?? null, liteLLMRemovedReason, liteLLMNeedsReview, laneMemberships,
      addedAt, addedBy: liveLiteLLMDeploymentId ? row.addedBy : null,
      isNew: Boolean(meta?.is_new), alsoAt: Number(meta?.also_at ?? 0),
      promotable: promotableReason === null, promotableReason,
    };
  });
  return { rows: enriched, total, page, pageSize, pageCount, counts };
}
export type CandidateRow = Awaited<ReturnType<typeof getCandidatePage>>["rows"][number];

export interface CandidateCheckPoint { at: Date; status: string; httpStatus: number | null; error: string | null }

/** Recent availability-check history for uptime strips, for the given candidates only (the rows on the page).
 *
 *  Ranked per candidate in SQL (the same row_number() shape getBenchmarkStats uses) rather than by taking the newest N rows
 *  table-wide and bucketing them in memory. That older approach silently starved every row once the table outgrew its global
 *  cap, collapsing every strip to one or two bars while weeks of checks sat unread. A per-candidate window can't degrade that
 *  way, and restricting it to the page's ids keeps it cheap however many candidates and checks exist. */
export async function getCandidateCheckHistory(candidateIds: string[], perCandidate = 12): Promise<Map<string, CandidateCheckPoint[]>> {
  const byCandidate = new Map<string, CandidateCheckPoint[]>();
  if (!candidateIds.length) return byCandidate;
  const ids = sql.join(candidateIds.map(id => sql`${id}::uuid`), sql`, `);
  const rows = await getDb().execute(sql`
    with ranked as (
      select candidate_id, created_at, status, http_status, error,
        row_number() over (partition by candidate_id order by created_at desc) as rn
      from candidate_checks where candidate_id in (${ids})
    )
    select candidate_id as "candidateId", created_at as "at", status, http_status as "httpStatus", error
    from ranked where rn <= ${perCandidate} order by candidate_id, created_at desc
  `) as unknown as Array<Omit<CandidateCheckPoint,"at"> & { at: Date | string; candidateId: string }>;
  for (const { candidateId, ...point } of rows) {
    const list = byCandidate.get(candidateId) ?? [];
    list.push({...point, at: historyTimestamp(point.at)});
    byCandidate.set(candidateId, list);
  }
  return byCandidate;
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

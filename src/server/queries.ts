import "server-only";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { candidateChecks, canonicalModels, laneAssignments, lanes, modelCandidates, modelDeployments, providers, providerCredentialReferences, rateLimitProfiles, smokeTests, syncRuns } from "./db/schema";
import { providerSlug, resolveProvider } from "./providers/catalog";
import { matchDeployment, matchDeployments } from "./discovery/model-key";
import { resolveVerificationEndpoint } from "./discovery/verify";
import { laneStatus, type LaneStatus } from "./status";

export interface ProviderRow { id: string; slug: string; name: string; status: string; adapterCapability: string; modelCount: number; healthyCount: number; credentialConfigured: boolean; credentialVerified?: boolean; enabled?: boolean; credentialState?: string; lastDiscoveryAt: Date | null }
export interface DeploymentRow { id: string; slug: string; modelName: string; providerModelId: string; litellmModelName: string; litellmDeploymentId: string | null; providerName: string; managed: boolean; health: string; score: number | null; freeType: string; contextWindow: number | null; rpmLimit: number | null; tpmLimit: number | null; safeRpm: number | null; safeTpm: number | null; confidence: string; lastTestedAt: Date | null; benchmarkRunCount: number; lastBenchmarkStatus: string | null; apiBase?: string | null; backend?: string | null; host?: string | null; rateLimitProfileId: string | null; observedRpm: number | null; observedTpm: number | null; manualRpm: number | null; manualTpm: number | null; lastProbeAt: Date | null }
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
    credentialConfigured: sql<boolean>`count(${providerCredentialReferences.id}) filter (where ${providerCredentialReferences.disabled} = false) > 0`,credentialVerified:sql<boolean>`coalesce(bool_or(${providerCredentialReferences.valid}) filter (where ${providerCredentialReferences.disabled} = false),false)`, lastDiscoveryAt: providers.lastDiscoveryAt,
  }).from(providers).leftJoin(modelDeployments, eq(providers.id, modelDeployments.providerId)).leftJoin(providerCredentialReferences, eq(providers.id, providerCredentialReferences.providerId)).groupBy(providers.id).orderBy(providers.name);
  const refs = await db.select().from(providerCredentialReferences);
  return rows.map(row => {
    const available = refs.filter(ref => ref.providerId === row.id && !ref.disabled && (ref.encryptedValue || process.env[ref.environmentVariable]));
    return {...row, healthyCount: Number(row.healthyCount), credentialConfigured: available.length > 0, credentialVerified: available.some(ref => ref.valid === true), credentialState: !available.length ? "MISSING" : available.some(ref => ref.valid === true) ? "CONFIGURED" : available.some(ref => ref.valid === false) ? "INVALID" : "UNKNOWN"};
  });
}

export async function getProvider(id: string) {
  const db=getDb(); const provider=(await db.select().from(providers).where(eq(providers.id,id)).limit(1))[0];
  if(!provider)return null;
  const credentials=await db.select({environmentVariable:providerCredentialReferences.environmentVariable,valueHint:providerCredentialReferences.valueHint,valid:providerCredentialReferences.valid,lastValidatedAt:providerCredentialReferences.lastValidatedAt}).from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId,id));
  const deployments=await getDeployments();
  return {provider,credentials,deployments:deployments.filter(item=>item.providerName===provider.name)};
}

export async function getDeployments(): Promise<DeploymentRow[]> {
  const rows = await getDb().select({
    id: modelDeployments.id, slug: canonicalModels.slug, modelName: canonicalModels.name, providerModelId: modelDeployments.providerModelId,
    litellmModelName: modelDeployments.litellmModelName, litellmDeploymentId: modelDeployments.litellmDeploymentId, providerName: providers.name, managed: modelDeployments.managed,
    health: modelDeployments.health, score: modelDeployments.score, freeType: modelDeployments.freeType, contextWindow: canonicalModels.contextWindow,
    rpmLimit: rateLimitProfiles.rpmLimit, tpmLimit: rateLimitProfiles.tpmLimit, safeRpm: rateLimitProfiles.safeRpm, safeTpm: rateLimitProfiles.safeTpm,
    confidence: rateLimitProfiles.confidence, lastTestedAt: modelDeployments.lastTestedAt,
    rateLimitProfileId: rateLimitProfiles.id, observedRpm: rateLimitProfiles.observedRpm, observedTpm: rateLimitProfiles.observedTpm,
    manualRpm: rateLimitProfiles.manualRpm, manualTpm: rateLimitProfiles.manualTpm, lastProbeAt: rateLimitProfiles.lastProbeAt,
    benchmarkRunCount: sql<number>`(select count(*)::int from smoke_tests where smoke_tests.deployment_id = ${modelDeployments.id})`,
    lastBenchmarkStatus: sql<string | null>`(select status::text from smoke_tests where smoke_tests.deployment_id = ${modelDeployments.id} order by created_at desc limit 1)`,
    apiBase:modelDeployments.apiBase,rawMetadata:modelDeployments.rawMetadata,
  }).from(modelDeployments).innerJoin(canonicalModels, eq(modelDeployments.canonicalModelId, canonicalModels.id)).innerJoin(providers, eq(modelDeployments.providerId, providers.id)).leftJoin(rateLimitProfiles, eq(modelDeployments.id, rateLimitProfiles.deploymentId)).orderBy(desc(modelDeployments.managed), providers.name, canonicalModels.name);
  return rows.map(({rawMetadata,...row}) => {const info=rawMetadata&&typeof rawMetadata.model_info==="object"?rawMetadata.model_info as Record<string,unknown>:{};return {...row,confidence:row.confidence??"UNKNOWN",backend:typeof info.backend==="string"?info.backend:null,host:typeof info.host==="string"?info.host:null};});
}

export async function getDeployment(id: string) {
  const rows = await getDeployments();
  return rows.find(row => row.id === id) ?? null;
}

export async function getModelCandidates(){
  const db=getDb();const [rows,providerRows,credentialRows,deploymentRows,laneRows]=await Promise.all([
    db.select().from(modelCandidates).orderBy(desc(modelCandidates.verifiedFree),modelCandidates.source,modelCandidates.displayName),
    db.select({id:providers.id,slug:providers.slug,name:providers.name,baseUrl:providers.baseUrl}).from(providers),
    db.select({providerId:providerCredentialReferences.providerId,valid:providerCredentialReferences.valid}).from(providerCredentialReferences),
    db.select({id:modelDeployments.id,providerId:modelDeployments.providerId,providerModelId:modelDeployments.providerModelId,health:modelDeployments.health,managed:modelDeployments.managed,litellmModelName:modelDeployments.litellmModelName}).from(modelDeployments),
    db.select({deploymentId:laneAssignments.deploymentId,slug:lanes.slug,excluded:laneAssignments.excluded}).from(laneAssignments).innerJoin(lanes,eq(laneAssignments.laneId,lanes.id)),
  ]);
  return rows.map(row=>{
    const slug=row.source==="openrouter"?"openrouter":providerSlug(row.providerName,row.modelRef);
    const provider=providerRows.find(item=>item.slug===slug||item.name.toLowerCase()===String(row.providerName??"").toLowerCase());
    const credentials=provider?credentialRows.filter(item=>item.providerId===provider.id):[];
    const credentialVerified=credentials.some(item=>item.valid===true);
    const deployments=provider?matchDeployments(deploymentRows,provider.id,row.modelRef):[];
    const deployment=provider?matchDeployment(deploymentRows,provider.id,row.modelRef):null;
    const deploymentIds=new Set(deployments.map(item=>item.id));
    const laneMemberships=laneRows.filter(lane=>!lane.excluded&&deploymentIds.has(lane.deploymentId)).map(lane=>({slug:lane.slug,health:deployments.find(item=>item.id===lane.deploymentId)?.health??"UNKNOWN"}));
    const definition=resolveProvider(row.source==="openrouter"?"openrouter":row.providerName,row.modelRef);
    const endpoint=definition?resolveVerificationEndpoint(definition,provider?.baseUrl??null):null;
    const promotableReason=!provider?"Provider not resolved":!credentialVerified?"Credential not verified":!endpoint?"No known endpoint for this provider":null;
    return {...row,providerId:provider?.id??null,credentialConfigured:credentials.length>0,credentialVerified,liteLLMDeploymentId:deployment?.id??null,liteLLMHealth:deployment?.health??null,liteLLMManaged:deployment?.managed??null,laneMemberships,promotable:promotableReason===null,promotableReason};
  });
}

export interface CandidateCheckPoint { at: Date; status: string; httpStatus: number | null; error: string | null }

/** Recent per-candidate availability-check history for uptime strips. One query, grouped in memory to avoid N+1 per row. */
export async function getCandidateCheckHistory(perCandidate = 30, rawLimit = 4000): Promise<Map<string, CandidateCheckPoint[]>> {
  const rows = await getDb().select({
    candidateId: candidateChecks.candidateId, at: candidateChecks.createdAt, status: candidateChecks.status,
    httpStatus: candidateChecks.httpStatus, error: candidateChecks.error,
  }).from(candidateChecks).orderBy(desc(candidateChecks.createdAt)).limit(rawLimit);
  const byCandidate = new Map<string, CandidateCheckPoint[]>();
  for (const row of rows) {
    const list = byCandidate.get(row.candidateId) ?? [];
    if (list.length < perCandidate) list.push({at: row.at, status: row.status, httpStatus: row.httpStatus, error: row.error});
    byCandidate.set(row.candidateId, list);
  }
  return byCandidate;
}

export async function getLanes(): Promise<LaneSummary[]> {
  const db = getDb();
  const rows = await db.select({
    id: lanes.id, slug: lanes.slug, name: lanes.name, enabled: lanes.enabled, minimumHealthy: lanes.minimumHealthy,
    total: sql<number>`count(${laneAssignments.id}) filter (where ${laneAssignments.excluded} = false)`,
    healthy: sql<number>`count(${laneAssignments.id}) filter (where ${laneAssignments.excluded} = false and ${modelDeployments.health} = 'HEALTHY')`,
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

export async function getRuns(options: {type?: string; limit?: number} = {}): Promise<RunRow[]> {
  const query = getDb().select().from(syncRuns);
  const rows = await (options.type ? query.where(eq(syncRuns.type, options.type)) : query).orderBy(desc(syncRuns.createdAt)).limit(options.limit ?? 12);
  return rows.map(row => ({ id: row.id, type: row.type, status: row.status, createdAt: row.createdAt, durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null, summary: row.summary }));
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
export async function getDeploymentSmokeHistory(perDeployment = 30, rawLimit = 4000): Promise<Map<string, SmokeHistoryPoint[]>> {
  const rows = await getDb().select({
    deploymentId: smokeTests.deploymentId, at: smokeTests.createdAt, status: smokeTests.status,
    httpStatus: smokeTests.httpStatus, latencyMs: smokeTests.latencyMs, error: smokeTests.error,
  }).from(smokeTests).where(isNotNull(smokeTests.deploymentId)).orderBy(desc(smokeTests.createdAt)).limit(rawLimit);
  const byDeployment = new Map<string, SmokeHistoryPoint[]>();
  for (const row of rows) {
    if (!row.deploymentId) continue;
    const list = byDeployment.get(row.deploymentId) ?? [];
    if (list.length < perDeployment) list.push({at: row.at, status: row.status, httpStatus: row.httpStatus, latencyMs: row.latencyMs, error: row.error});
    byDeployment.set(row.deploymentId, list);
  }
  return byDeployment;
}

/** Recent per-provider smoke-test history (across all of a provider's deployments) for uptime strips. */
export async function getProviderSmokeHistory(perProvider = 20, rawLimit = 6000): Promise<Map<string, SmokeHistoryPoint[]>> {
  const rows = await getDb().select({
    providerId: modelDeployments.providerId, at: smokeTests.createdAt, status: smokeTests.status,
    httpStatus: smokeTests.httpStatus, latencyMs: smokeTests.latencyMs, error: smokeTests.error,
  }).from(smokeTests)
    .innerJoin(modelDeployments, eq(smokeTests.deploymentId, modelDeployments.id))
    .orderBy(desc(smokeTests.createdAt)).limit(rawLimit);
  const byProvider = new Map<string, SmokeHistoryPoint[]>();
  for (const row of rows) {
    const list = byProvider.get(row.providerId) ?? [];
    if (list.length < perProvider) list.push({at: row.at, status: row.status, httpStatus: row.httpStatus, latencyMs: row.latencyMs, error: row.error});
    byProvider.set(row.providerId, list);
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

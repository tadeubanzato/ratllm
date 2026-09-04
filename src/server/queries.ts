import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { canonicalModels, laneAssignments, lanes, modelCandidates, modelDeployments, providers, providerCredentialReferences, rateLimitProfiles, smokeTests, syncRuns } from "./db/schema";
import { providerSlug } from "./providers/catalog";
import { laneStatus, type LaneStatus } from "./status";

export interface ProviderRow { id: string; slug: string; name: string; status: string; adapterCapability: string; modelCount: number; healthyCount: number; credentialConfigured: boolean; credentialVerified?: boolean; lastDiscoveryAt: Date | null }
export interface DeploymentRow { id: string; slug: string; modelName: string; providerModelId: string; litellmModelName: string; litellmDeploymentId: string | null; providerName: string; managed: boolean; health: string; score: number | null; freeType: string; contextWindow: number | null; rpmLimit: number | null; tpmLimit: number | null; safeRpm: number | null; safeTpm: number | null; confidence: string; lastTestedAt: Date | null; benchmarkRunCount: number; lastBenchmarkStatus: string | null; apiBase?: string | null; backend?: string | null; host?: string | null }
export interface LaneSummary { id: string; slug: string; name: string; enabled: boolean; healthy: number; total: number; minimumHealthy: number; status: LaneStatus; confidence: string }
export interface RunRow { id: string; type: string; status: string; createdAt: Date; durationMs: number | null; summary: Record<string, unknown> }
export interface DashboardData {
  demo: boolean;
  systems: { curator: string; database: string; litellm: string; n8n: string };
  kpis: { providers: number; models: number; active: number; healthy: number; quarantined: number; coverage: number; errors429: number; pendingChanges: number };
  lanes: LaneSummary[]; providers: ProviderRow[]; runs: RunRow[];
  incidents: Array<{ severity: string; title: string; detail: string; at: Date }>;
}

export async function getProviders(): Promise<ProviderRow[]> {
  const db = getDb();
  return db.select({
    id: providers.id, slug: providers.slug, name: providers.name, status: providers.status, adapterCapability: providers.adapterCapability,
    modelCount: count(modelDeployments.id),
    healthyCount: sql<number>`count(${modelDeployments.id}) filter (where ${modelDeployments.health} = 'HEALTHY')`,
    credentialConfigured: sql<boolean>`count(${providerCredentialReferences.id}) > 0`,credentialVerified:sql<boolean>`coalesce(bool_or(${providerCredentialReferences.valid}),false)`, lastDiscoveryAt: providers.lastDiscoveryAt,
  }).from(providers).leftJoin(modelDeployments, eq(providers.id, modelDeployments.providerId)).leftJoin(providerCredentialReferences, eq(providers.id, providerCredentialReferences.providerId)).groupBy(providers.id).orderBy(providers.name);
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
  const db=getDb();const [rows,providerRows,credentialRows]=await Promise.all([db.select().from(modelCandidates).orderBy(desc(modelCandidates.verifiedFree),modelCandidates.source,modelCandidates.displayName),db.select({id:providers.id,slug:providers.slug,name:providers.name}).from(providers),db.select({providerId:providerCredentialReferences.providerId,valid:providerCredentialReferences.valid}).from(providerCredentialReferences)]);
  return rows.map(row=>{const slug=row.source==="openrouter"?"openrouter":providerSlug(row.providerName,row.modelRef);const provider=providerRows.find(item=>item.slug===slug||item.name.toLowerCase()===String(row.providerName??"").toLowerCase());const credentials=provider?credentialRows.filter(item=>item.providerId===provider.id):[];return {...row,providerId:provider?.id??null,credentialConfigured:credentials.length>0,credentialVerified:credentials.some(item=>item.valid===true)};});
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

export async function getRuns(): Promise<RunRow[]> {
  const rows = await getDb().select().from(syncRuns).orderBy(desc(syncRuns.createdAt)).limit(12);
  return rows.map(row => ({ id: row.id, type: row.type, status: row.status, createdAt: row.createdAt, durationMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null, summary: row.summary }));
}

export async function getSmokeTests(limit = 20) {
  return getDb().select().from(smokeTests).orderBy(desc(smokeTests.createdAt)).limit(limit);
}

export async function getDashboard(): Promise<DashboardData> {
  const [{ demoDashboard }, { env }] = await Promise.all([import("./demo-data"), import("./config")]);
  if (env.DEMO_MODE) return demoDashboard;
  const [providerRows, deploymentRows, laneRows, runRows] = await Promise.all([getProviders(), getDeployments(), getLanes(), getRuns()]);
  const enabledLanes = laneRows.filter(lane => lane.enabled);
  const covered = enabledLanes.filter(lane => lane.status === "HEALTHY").length;
  const [recent429, quarantined] = await Promise.all([
    getDb().select({ value: sql<number>`count(*)` }).from(smokeTests).where(sql`${smokeTests.createdAt} >= now() - interval '24 hours' and ${smokeTests.httpStatus} = 429`),
    getDb().select({ value: sql<number>`count(*)` }).from(canonicalModels).where(eq(canonicalModels.lifecycle, "QUARANTINED")),
  ]);
  return {
    demo: false, systems: { curator: "HEALTHY", database: "HEALTHY", litellm: deploymentRows.some(row => row.health === "HEALTHY") ? "HEALTHY" : deploymentRows.length ? "DEGRADED" : "NOT_SYNCED", n8n: env.N8N_BASE_URL && env.N8N_API_KEY ? "CONFIGURED" : "NOT_CONFIGURED" },
    kpis: { providers: providerRows.length, models: deploymentRows.length, active: deploymentRows.length, healthy: deploymentRows.filter(row => row.health === "HEALTHY").length, quarantined: Number(quarantined[0]?.value ?? 0), coverage: enabledLanes.length ? Math.round(covered / enabledLanes.length * 100) : 0, errors429: Number(recent429[0]?.value ?? 0), pendingChanges: 0 },
    lanes: laneRows, providers: providerRows, runs: runRows, incidents: laneRows.filter(lane => lane.enabled && lane.status !== "HEALTHY").map(lane => ({ severity: "WARNING", title: `${lane.slug} ${lane.status === "UNASSIGNED" ? "has no assignments" : "is below redundancy target"}`, detail: `${lane.healthy}/${lane.minimumHealthy} healthy assigned deployments`, at: new Date() })),
  };
}

export async function withDemo<T>(query: () => Promise<T>, demo: () => T): Promise<T> {
  const { env } = await import("./config");
  return env.DEMO_MODE ? demo() : query();
}

import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { canonicalModels, lanes, modelCandidates, modelDeployments, providers, providerCredentialReferences, rateLimitProfiles, smokeTests, syncRuns } from "./db/schema";

export interface ProviderRow { id: string; slug: string; name: string; status: string; adapterCapability: string; modelCount: number; healthyCount: number; credentialConfigured: boolean; credentialVerified?: boolean; lastDiscoveryAt: Date | null }
export interface DeploymentRow { id: string; slug: string; modelName: string; providerModelId: string; litellmModelName: string; providerName: string; managed: boolean; health: string; score: number | null; freeType: string; contextWindow: number | null; rpmLimit: number | null; tpmLimit: number | null; safeRpm: number | null; safeTpm: number | null; confidence: string; lastTestedAt: Date | null; apiBase?: string | null; backend?: string | null; host?: string | null }
export interface LaneSummary { id: string; slug: string; name: string; healthy: number; total: number; minimumHealthy: number; confidence: string }
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
    litellmModelName: modelDeployments.litellmModelName, providerName: providers.name, managed: modelDeployments.managed,
    health: modelDeployments.health, score: modelDeployments.score, freeType: modelDeployments.freeType, contextWindow: canonicalModels.contextWindow,
    rpmLimit: rateLimitProfiles.rpmLimit, tpmLimit: rateLimitProfiles.tpmLimit, safeRpm: rateLimitProfiles.safeRpm, safeTpm: rateLimitProfiles.safeTpm,
    confidence: rateLimitProfiles.confidence, lastTestedAt: modelDeployments.lastTestedAt,apiBase:modelDeployments.apiBase,rawMetadata:modelDeployments.rawMetadata,
  }).from(modelDeployments).innerJoin(canonicalModels, eq(modelDeployments.canonicalModelId, canonicalModels.id)).innerJoin(providers, eq(modelDeployments.providerId, providers.id)).leftJoin(rateLimitProfiles, eq(modelDeployments.id, rateLimitProfiles.deploymentId)).orderBy(desc(modelDeployments.managed), providers.name, canonicalModels.name);
  return rows.map(({rawMetadata,...row}) => {const info=rawMetadata&&typeof rawMetadata.model_info==="object"?rawMetadata.model_info as Record<string,unknown>:{};return {...row,confidence:row.confidence??"UNKNOWN",backend:typeof info.backend==="string"?info.backend:null,host:typeof info.host==="string"?info.host:null};});
}

export async function getDeployment(id: string) {
  const rows = await getDeployments();
  return rows.find(row => row.id === id) ?? null;
}

export async function getModelCandidates(){
  const db=getDb();const [rows,providerRows,credentialRows]=await Promise.all([db.select().from(modelCandidates).orderBy(desc(modelCandidates.verifiedFree),modelCandidates.source,modelCandidates.displayName),db.select({id:providers.id,slug:providers.slug,name:providers.name}).from(providers),db.select({providerId:providerCredentialReferences.providerId,valid:providerCredentialReferences.valid}).from(providerCredentialReferences)]);
  return rows.map(row=>{const providerSlug=row.source==="openrouter"?"openrouter":(row.providerName??row.modelRef.split("/",1)[0]??"").toLowerCase().replace(/[^a-z0-9]+/g,"-");const provider=providerRows.find(item=>item.slug===providerSlug||item.name.toLowerCase()===String(row.providerName??"").toLowerCase());const credentials=provider?credentialRows.filter(item=>item.providerId===provider.id):[];return {...row,providerId:provider?.id??null,credentialConfigured:credentials.length>0,credentialVerified:credentials.some(item=>item.valid===true)};});
}

export async function getLanes(): Promise<LaneSummary[]> {
  const db = getDb();
  const rows = await db.select().from(lanes).orderBy(lanes.slug);
  return rows.map(row => ({ id: row.id, slug: row.slug, name: row.name, healthy: 0, total: 0, minimumHealthy: row.minimumHealthy, confidence: "UNKNOWN" }));
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
  const covered = laneRows.filter(lane => lane.healthy >= lane.minimumHealthy).length;
  return {
    demo: false, systems: { curator: "HEALTHY", database: "HEALTHY", litellm: deploymentRows.length ? "HEALTHY" : "DEGRADED", n8n: env.N8N_BASE_URL ? "HEALTHY" : "DEGRADED" },
    kpis: { providers: providerRows.length, models: deploymentRows.length, active: deploymentRows.length, healthy: deploymentRows.filter(row => row.health === "HEALTHY").length, quarantined: deploymentRows.filter(row => row.health === "DEGRADED").length, coverage: laneRows.length ? Math.round(covered/laneRows.length*100) : 0, errors429: 0, pendingChanges: 0 },
    lanes: laneRows, providers: providerRows, runs: runRows, incidents: laneRows.filter(lane => lane.healthy < lane.minimumHealthy).map(lane => ({ severity: "WARNING", title: `${lane.slug} below redundancy target`, detail: `${lane.healthy}/${lane.minimumHealthy} healthy deployments`, at: new Date() })),
  };
}

export async function withDemo<T>(query: () => Promise<T>, demo: () => T): Promise<T> {
  const { env } = await import("./config");
  return env.DEMO_MODE ? demo() : query();
}

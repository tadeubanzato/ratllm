import "server-only";
import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { CURATOR_MANAGED_BY, CURATOR_VERSION } from "@/lib/constants";
import { getDb } from "@/server/db/client";
import { auditEvents, canonicalModels, laneAssignments, lanes, modelDeployments, providers, syncRuns } from "@/server/db/schema";
import { log } from "@/server/logging";
import { resolveProvider } from "@/server/providers/catalog";
import { deploymentIdentity, isManagedDeployment, sanitizedMetadata } from "./classify";
import { HttpLiteLLMAdapter } from "./client";

function privateApiBase(value: unknown) { return typeof value === "string" && /localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|host\.docker/i.test(value); }
function providerIdentity(item: Awaited<ReturnType<HttpLiteLLMAdapter["listDeployments"]>>[number], model: string) {
  const backend=String(item.model_info.backend??"");
  if(backend.toLowerCase()==="mlx"||privateApiBase(item.litellm_params.api_base))return {slug:"local",name:String(item.model_info.source_provider??"Local / MLX")};
  // A deployment this app added carries the real provider name (its own model string is wrapped as "openai/<real id>" for the generic OpenAI-compatible route, so re-splitting that wrapper on "/" would misidentify the provider).
  if (item.model_info.managed_by === CURATOR_MANAGED_BY && typeof item.model_info.source_provider === "string") {
    const known = resolveProvider(item.model_info.source_provider, "");
    if (known) return {slug: known.slug, name: known.name};
  }
  const slug=model.includes("/")?model.split("/",1)[0]!.toLowerCase():"litellm";
  return {slug,name:slug==="litellm"?"LiteLLM / Custom":slug.replace(/^./,c=>c.toUpperCase())};
}
function canonicalSlug(model: string) { return model.split("/").at(-1)!.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"); }

export async function syncLiteLLM(options: { dryRun?: boolean } = {}, adapter = new HttpLiteLLMAdapter()) {
  const db = getDb(); const correlationId = randomUUID();
  const [run] = await db.insert(syncRuns).values({ type: "LITELLM_SYNC", status: "RUNNING", correlationId, startedAt: new Date() }).returning();
  try {
    const remote = await adapter.listDeployments(); let managed = 0; let unmanaged = 0;
    if (options.dryRun) {
      const existing = await db.select({ id: modelDeployments.litellmDeploymentId }).from(modelDeployments);
      const current = new Set(existing.map(row => row.id).filter((id): id is string => id !== null));
      const incoming = remote.map(item => deploymentIdentity(item).deploymentId);
      const summary = { dryRun: true, before: current.size, after: incoming.length, added: incoming.filter(id => !current.has(id)), removed: [...current].filter(id => !incoming.includes(id)), updated: incoming.filter(id => current.has(id)), laneChanges: [], rateLimitChanges: [] };
      await db.update(syncRuns).set({ status: "SUCCEEDED", summary, finishedAt: new Date(), updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
      return { runId: run.id, correlationId, ...summary };
    }
    const remoteDeploymentIds: string[] = [];
    for (const item of remote) {
      const identity = deploymentIdentity(item); remoteDeploymentIds.push(identity.deploymentId); const providerIdentityValue=providerIdentity(item,identity.providerModelId); const slug=providerIdentityValue.slug;
      let provider = (await db.select().from(providers).where(eq(providers.slug, slug)).limit(1))[0];
      if (!provider) [provider] = await db.insert(providers).values({ slug, name: providerIdentityValue.name, adapterKey: "manual", adapterCapability: "MANUAL" }).returning();
      const sourceModel=typeof item.model_info.source_model==="string"?item.model_info.source_model:identity.providerModelId;
      const modelSlug = canonicalSlug(sourceModel);
      let model = (await db.select().from(canonicalModels).where(eq(canonicalModels.slug, modelSlug)).limit(1))[0];
      const modelName=typeof item.model_info.source_model==="string"?item.model_info.source_model:modelSlug.replace(/[-_]/g," ").replace(/\b\w/g,c=>c.toUpperCase());
      if (!model) [model] = await db.insert(canonicalModels).values({ slug: modelSlug, name:modelName, lifecycle: "ACTIVE" }).returning();
      const managedFlag = isManagedDeployment(item);
      if (managedFlag) managed += 1; else unmanaged += 1;
      const existing = (await db.select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, identity.deploymentId)).limit(1))[0];
      const values = { canonicalModelId: model.id, providerId: provider.id, providerModelId: identity.providerModelId, litellmDeploymentId: identity.deploymentId, litellmModelName: item.model_name, managed: managedFlag, managedBy: managedFlag ? String(item.model_info.managed_by) : null, curatorVersion: managedFlag ? String(item.model_info.curator_version ?? CURATOR_VERSION) : null, apiBase: typeof item.litellm_params.api_base === "string" ? item.litellm_params.api_base : null, rawMetadata: sanitizedMetadata(item), lastSeenAt: new Date() };
      if (existing) await db.update(modelDeployments).set({ ...values, updatedAt: new Date() }).where(eq(modelDeployments.id, existing.id));
      else await db.insert(modelDeployments).values(values);
    }
    // Preserve inventory history, but never keep a removed router deployment
    // eligible through an old HEALTHY result after a successful inventory sync.
    const missingFromRouter = remoteDeploymentIds.length
      ? and(isNotNull(modelDeployments.litellmDeploymentId), notInArray(modelDeployments.litellmDeploymentId, remoteDeploymentIds))
      : isNotNull(modelDeployments.litellmDeploymentId);
    await db.update(modelDeployments).set({ health: "UNAVAILABLE", updatedAt: new Date() }).where(missingFromRouter);
    const summary = { deployments: remote.length, managed, unmanaged };
    await db.update(syncRuns).set({ status: "SUCCEEDED", summary, finishedAt: new Date(), updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    await db.insert(auditEvents).values({ actor: "system", action: "litellm.inventory.synced", entityType: "sync_run", entityId: run.id, after: summary, correlationId });
    return { runId: run.id, correlationId, ...summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync failure";
    await db.update(syncRuns).set({ status: "FAILED", error: message, finishedAt: new Date(), updatedAt: new Date() }).where(eq(syncRuns.id, run.id));
    log("error", "LiteLLM inventory sync failed", { correlationId, error: message }); throw error;
  }
}

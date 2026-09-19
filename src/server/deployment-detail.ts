import "server-only";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { auditEvents, candidateChecks, laneAssignments, lanes, modelCandidates, modelDeployments, providerCredentialReferences, providers, smokeTests } from "@/server/db/schema";
import { keyFingerprint } from "@/server/credentials/fingerprint";
import { resolveCredentialWithSource } from "@/server/discovery/verify";
import { removalHistoryOf } from "@/server/discovery/auto-add-policy";
import { bareModelKey } from "@/server/discovery/model-key";
import { sourceRegistry } from "@/server/discovery/registry";
import { computeFailureStreak } from "@/server/health/failure-streak";
import { connectionSummary } from "@/server/settings/connections";

/** Everything the deployment detail page shows beyond the summary row: exact identity, the alias pool this deployment
 *  belongs to, its lane memberships, recent probes and audit trail. Every query is scoped to one deployment (or its alias),
 *  so cost doesn't grow with the size of the inventory. */
export async function getDeploymentDetail(id: string) {
  const db = getDb();
  const self = (await db.select({
    id: modelDeployments.id, litellmDeploymentId: modelDeployments.litellmDeploymentId, litellmModelName: modelDeployments.litellmModelName,
    lifecycle: modelDeployments.lifecycle, rawMetadata: modelDeployments.rawMetadata, apiBase: modelDeployments.apiBase,
    providerId: modelDeployments.providerId, providerModelId: modelDeployments.providerModelId, managed: modelDeployments.managed,
    createdAt: modelDeployments.createdAt, lastSeenAt: modelDeployments.lastSeenAt, updatedAt: modelDeployments.updatedAt,
  }).from(modelDeployments).where(eq(modelDeployments.id, id)).limit(1))[0];
  if (!self) return null;

  const [siblings, laneRows, probes, audit, connection] = await Promise.all([
    // Other members of the same alias pool. An alias is shared by every member, which is exactly why the LiteLLM ID — not
    // the alias — is what identifies one.
    db.select({
      id: modelDeployments.id, litellmDeploymentId: modelDeployments.litellmDeploymentId, providerModelId: modelDeployments.providerModelId,
      lifecycle: modelDeployments.lifecycle, health: modelDeployments.health, managed: modelDeployments.managed, providerName: providers.name, apiBase: modelDeployments.apiBase,
      credentialFingerprint: sql<string | null>`${modelDeployments.rawMetadata}->'model_info'->>'ratllm_credential_fingerprint'`,
    }).from(modelDeployments).innerJoin(providers, eq(modelDeployments.providerId, providers.id))
      .where(and(eq(modelDeployments.litellmModelName, self.litellmModelName), ne(modelDeployments.id, id)))
      .orderBy(modelDeployments.lifecycle, providers.name).limit(50),
    db.select({ slug: lanes.slug, name: lanes.name, priority: laneAssignments.priority, excluded: laneAssignments.excluded, pinned: laneAssignments.pinned, since: laneAssignments.createdAt, explanation: laneAssignments.explanation })
      .from(laneAssignments).innerJoin(lanes, eq(laneAssignments.laneId, lanes.id)).where(eq(laneAssignments.deploymentId, id)).orderBy(lanes.slug),
    db.select({
      at: smokeTests.createdAt, status: smokeTests.status, httpStatus: smokeTests.httpStatus, latencyMs: smokeTests.latencyMs,
      firstTokenMs: smokeTests.firstTokenMs, errorCode: smokeTests.errorCode, error: smokeTests.error,
    }).from(smokeTests).where(eq(smokeTests.deploymentId, id)).orderBy(desc(smokeTests.createdAt)).limit(25),
    db.select({ at: auditEvents.createdAt, actor: auditEvents.actor, action: auditEvents.action, correlationId: auditEvents.correlationId })
      .from(auditEvents).where(and(eq(auditEvents.entityType, "model_deployment"), eq(auditEvents.entityId, id))).orderBy(desc(auditEvents.createdAt)).limit(15),
    connectionSummary("litellm").catch(() => null),
  ]);

  const metadata = self.rawMetadata ?? {};
  const info = metadata.model_info && typeof metadata.model_info === "object" ? metadata.model_info as Record<string, unknown> : {};

  // The discovery record behind this deployment. A deployment RatLLM added carries its candidate's id in model_info; one
  // added directly in LiteLLM (or whose candidate was merged) is matched by provider + normalized model name instead.
  const linkedId = typeof info.source_candidate_id === "string" ? info.source_candidate_id : null;
  let candidate = linkedId ? (await db.select().from(modelCandidates).where(eq(modelCandidates.id, linkedId)).limit(1))[0] : undefined;
  let candidateLink: "recorded" | "matched" | null = candidate ? "recorded" : null;
  if (!candidate) {
    const key = bareModelKey(self.providerModelId);
    candidate = (await db.select().from(modelCandidates).where(eq(modelCandidates.providerId, self.providerId))).find(row => bareModelKey(row.modelRef) === key);
    if (candidate) candidateLink = "matched";
  }

  const [checkStats, promotions, firstProbe] = await Promise.all([
    candidate ? db.select({
      total: sql<number>`count(*)::int`,
      passed: sql<number>`(count(*) filter (where ${candidateChecks.status} = 'available'))::int`,
      firstPassAt: sql<Date | null>`min(${candidateChecks.createdAt}) filter (where ${candidateChecks.status} = 'available')`,
      lastAt: sql<Date | null>`max(${candidateChecks.createdAt})`,
    }).from(candidateChecks).where(eq(candidateChecks.candidateId, candidate.id)).then(rows => rows[0]) : Promise.resolve(null),
    // A promotion audit event is written on every promotion attempt — including hourly no-op re-runs where every target
    // already "exists" — so which events actually added something is decided below from each event's `targets`.
    candidate ? db.select({ at: auditEvents.createdAt, after: auditEvents.after })
      .from(auditEvents).where(and(eq(auditEvents.action, "litellm.candidate.promoted"), eq(auditEvents.entityId, candidate.id))).orderBy(asc(auditEvents.createdAt)).limit(500) : Promise.resolve([]),
    db.select({ at: sql<Date | null>`min(${smokeTests.createdAt})` }).from(smokeTests).where(eq(smokeTests.deploymentId, id)).then(rows => rows[0]?.at ?? null),
  ]);
  const asDate = (value: Date | string | null | undefined) => value ? new Date(value) : null;
  const source = candidate ? sourceRegistry.find(entry => entry.id === candidate.source) : undefined;
  const corroborating = candidate && Array.isArray(candidate.evidence.corroboratingSources) ? candidate.evidence.corroboratingSources as { source: string; sourceUrl: string }[] : [];
  const removals = candidate ? removalHistoryOf(candidate.evidence) : [];

  const credential = await describeCredential(db, self, info);

  // One chronological story of this model, from first being discovered to now. Each entry is only included when there's
  // a real timestamp behind it — nothing is inferred or back-filled.
  const timeline: { at: Date; label: string; detail?: string }[] = [];
  const push = (at: Date | null, label: string, detail?: string) => { if (at && !Number.isNaN(at.getTime())) timeline.push({ at, label, detail }); };
  if (candidate) push(candidate.firstSeenAt, "Discovered", `${source?.name ?? candidate.source}${source ? ` · tier ${source.tier}` : ""}`);
  if (checkStats) push(asDate(checkStats.firstPassAt), "First passed a direct provider check");
  // Only events that really added a target behind THIS deployment's alias are candidates. The result of an add carries the
  // alias and lane, not the new deployment's id — and every copy behind one alias shares them — so which event created THIS
  // deployment is decided by time: promotion adds to the router and syncs the inventory in the same pass, so the deployment
  // row appears within moments of its own addition. Pick the closest addition, and none if nothing is close.
  const ATTRIBUTION_WINDOW_MS = 15 * 60_000;
  const candidates = promotions.flatMap(promotion => {
    const targets = Array.isArray(promotion.after?.targets) ? promotion.after.targets as { target?: string; lane?: string | null; status?: string }[] : [];
    return targets.filter(target => target.status === "added" && target.target === self.litellmModelName).map(target => ({ at: promotion.at, lane: target.lane ?? null }));
  });
  const closest = candidates
    .map(addition => ({ addition, gap: Math.abs(addition.at.getTime() - self.createdAt.getTime()) }))
    .filter(entry => entry.gap <= ATTRIBUTION_WINDOW_MS)
    .sort((x, y) => x.gap - y.gap)[0]?.addition;
  const additions = closest ? [closest] : [];
  for (const addition of additions) push(addition.at, "Added to LiteLLM by RatLLM", addition.lane ? `lane ${addition.lane}` : "direct alias");
  push(self.createdAt, additions.length ? "First appeared in the LiteLLM inventory" : "First seen in the LiteLLM inventory", additions.length ? undefined : "no RatLLM addition was recorded for it");
  push(asDate(firstProbe), "First health check through LiteLLM");
  for (const lane of laneRows) push(lane.since, `Assigned to ${lane.name}`, lane.excluded ? "currently excluded" : undefined);
  for (const removal of removals) push(new Date(removal.at), "Auto-removed from LiteLLM", removal.reason);
  timeline.sort((x, y) => x.at.getTime() - y.at.getTime());

  return {
    instanceBaseUrl: connection?.baseUrl ?? null,
    blocked: info.blocked === true,
    removedReason: typeof metadata.removedReason === "string" ? metadata.removedReason : null,
    rawMetadata: metadata,
    siblings,
    lanes: laneRows,
    probes,
    audit,
    failureStreak: computeFailureStreak(probes.map(probe => ({ status: probe.status, errorCode: probe.errorCode }))),
    discovery: candidate ? {
      link: candidateLink!,
      candidateId: candidate.id,
      sourceId: candidate.source,
      sourceName: source?.name ?? candidate.source,
      sourceTier: source?.tier ?? null,
      sourceUrl: candidate.sourceUrl,
      firstSeenAt: candidate.firstSeenAt,
      lastSeenAt: candidate.lastSeenAt,
      freeType: candidate.freeType,
      verifiedFree: candidate.verifiedFree,
      contextWindow: candidate.contextWindow,
      maxOutputTokens: candidate.maxOutputTokens,
      supportsVision: candidate.supportsVision,
      supportsTools: candidate.supportsTools,
      supportsReasoning: candidate.supportsReasoning,
      corroborating,
      checks: checkStats ? { total: checkStats.total, passed: checkStats.passed, firstPassAt: asDate(checkStats.firstPassAt), lastAt: asDate(checkStats.lastAt) } : null,
    } : null,
    addedToLiteLLMAt: additions[0]?.at ?? null,
    credential,
    timeline,
  };
}

export type DeploymentDetail = NonNullable<Awaited<ReturnType<typeof getDeploymentDetail>>>;

export type CredentialStatus =
  | "matches"            // recorded fingerprint equals the provider's current key
  | "changed"            // recorded fingerprint differs: the provider's key was replaced after this deployment was added
  | "unknown"            // can't tell (credential row gone or unreadable, or no change history)
  | "inferred_current"   // not recorded; audit trail says the credential last changed BEFORE this deployment was added
  | "inferred_stale"     // not recorded; the credential changed AFTER this deployment was added
  | "external";          // added outside RatLLM: which key it uses isn't known to RatLLM

const asText = (value: unknown) => typeof value === "string" && value ? value : null;

/**
 * Which API key this deployment was created with, as far as RatLLM can know — without ever exposing a key.
 *
 * When RatLLM adds a deployment it records the credential row, whether the value came from the server environment or the
 * database, and a fingerprint of the key. That record is compared with the provider's key as this server sees it now. For
 * deployments that predate the record, it falls back to an inference from the audit trail (a RatLLM-managed deployment is
 * created from the provider's credential, so if that credential last changed before the deployment appeared, it was created
 * with the current key) and says it is an inference. The key itself is decrypted only to fingerprint it and never returned.
 */
async function describeCredential(db: ReturnType<typeof getDb>, self: { id: string; providerId: string; managed: boolean; createdAt: Date }, info: Record<string, unknown>) {
  const fingerprint = asText(info.ratllm_credential_fingerprint);
  const recorded = fingerprint ? { credentialId: asText(info.ratllm_credential_id), envVar: asText(info.ratllm_credential_env), source: asText(info.ratllm_credential_source), fingerprint } : null;

  const credentials = await db.select({ id: providerCredentialReferences.id, environmentVariable: providerCredentialReferences.environmentVariable, encryptedValue: providerCredentialReferences.encryptedValue })
    .from(providerCredentialReferences).where(eq(providerCredentialReferences.providerId, self.providerId)).orderBy(asc(providerCredentialReferences.createdAt));
  // With a recorded credential id, that row is the one to compare with. Without one, only an unambiguous single credential is.
  const wanted = recorded?.credentialId ? credentials.find(row => row.id === recorded.credentialId) : credentials.length === 1 ? credentials[0] : undefined;
  const resolved = wanted ? resolveCredentialWithSource(wanted) : null;
  const current = wanted && resolved ? { envVar: wanted.environmentVariable, source: resolved.source, fingerprint: keyFingerprint(resolved.secret) } : null;

  const lastChangeRow = (await db.select({ at: sql<Date | string | null>`max(${auditEvents.createdAt})` }).from(auditEvents)
    .where(and(eq(auditEvents.action, "provider.credential.updated"), eq(auditEvents.entityId, self.providerId))))[0];
  const lastChangedAt = lastChangeRow?.at ? new Date(lastChangeRow.at) : null;

  let status: CredentialStatus;
  if (recorded) status = current ? (current.fingerprint === recorded.fingerprint ? "matches" : "changed") : "unknown";
  else if (!self.managed) status = "external";
  else if (!lastChangedAt || !wanted) status = "unknown";
  else status = lastChangedAt.getTime() <= self.createdAt.getTime() ? "inferred_current" : "inferred_stale";

  return { status, recorded, current, lastChangedAt, environmentOverride: resolved?.source === "environment" };
}

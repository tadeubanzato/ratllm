import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { CURATOR_MANAGED_BY } from "@/lib/constants";
import { getDb } from "@/server/db/client";
import { auditEvents, laneAssignments, modelDeployments, providers } from "@/server/db/schema";
import { apiError, correlationId } from "@/server/http";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";
import { adoptDeployment, planAdoption } from "@/server/litellm/adoption";
import { confirmationPhrase } from "@/server/litellm/confirmation";
import { sanitizedMetadata } from "@/server/litellm/classify";

const input = z.object({ action: z.enum(["deactivate", "reactivate", "delete", "adopt"]), confirmation: z.string().min(1) });

/** Guarded by a typed confirmation that names the EXACT deployment — the action word plus the start of its LiteLLM ID.
 *  It used to be the alias, which is shared by every member of a lane's pool: with several identical copies of one model
 *  behind an alias, nothing stopped you confirming a delete against the wrong one. Talking to LiteLLM is still gated by the
 *  master key configured in Settings → LiteLLM, which HttpLiteLLMAdapter reads server-side. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_REQUEST", "A lifecycle action and confirmation are required", 400, correlation);
  const { id } = await params;
  const db = getDb();
  const row = (await db.select({ deployment: modelDeployments, providerSlug: providers.slug }).from(modelDeployments).innerJoin(providers, eq(modelDeployments.providerId, providers.id)).where(eq(modelDeployments.id, id)).limit(1))[0];
  if (!row) return apiError("DEPLOYMENT_NOT_FOUND", "Deployment does not exist in Curator inventory", 404, correlation);
  const deployment = row.deployment;
  if (!deployment.litellmDeploymentId || deployment.lifecycle === "REMOVED") return apiError("DEPLOYMENT_NOT_LIVE", "This deployment is no longer present in LiteLLM", 409, correlation);

  const expected = confirmationPhrase(parsed.data.action, deployment.litellmDeploymentId);
  if (parsed.data.confirmation !== expected) return apiError("CONFIRMATION_REQUIRED", `Type exactly: ${expected}`, 409, correlation);

  const before = { litellmDeploymentId: deployment.litellmDeploymentId, health: deployment.health, lifecycle: deployment.lifecycle, action: parsed.data.action };
  try {
    const adapter = new HttpLiteLLMAdapter();
    if (parsed.data.action === "adopt") return await adopt(adapter, deployment, row.providerSlug, correlation);

    if (parsed.data.action === "delete") {
      await adapter.removeDeployment(deployment.litellmDeploymentId);
      // The LiteLLM ID is kept: it is the record of which router deployment this was, and every live-only rule (health probes,
      // "already exists" checks, lane capacity) is decided by lifecycle, not by whether an ID is present.
      await db.update(modelDeployments).set({ health: "UNAVAILABLE", lifecycle: "REMOVED", rawMetadata: { ...deployment.rawMetadata, removedAt: new Date().toISOString(), removedReason: "Deleted by an operator" }, updatedAt: new Date() }).where(eq(modelDeployments.id, id));
      await db.update(laneAssignments).set({ excluded: true, explanation: { source: "OPERATOR_DELETE", reason: "deleted from LiteLLM by an operator", at: new Date().toISOString() }, updatedAt: new Date() }).where(eq(laneAssignments.deploymentId, id));
    } else {
      const blocked = parsed.data.action === "deactivate";
      await adapter.setDeploymentBlocked(deployment.litellmDeploymentId, blocked);
      await db.update(modelDeployments).set({ health: blocked ? "UNAVAILABLE" : "UNKNOWN", lifecycle: blocked ? "DEACTIVATED" : "ACTIVE", rawMetadata: { ...deployment.rawMetadata, blocked }, updatedAt: new Date() }).where(eq(modelDeployments.id, id));
    }
    await db.insert(auditEvents).values({ actor: "admin", action: `litellm.deployment.${parsed.data.action}`, entityType: "model_deployment", entityId: id, before, after: { alias: deployment.litellmModelName, litellmDeploymentId: deployment.litellmDeploymentId }, correlationId: correlation });
    return NextResponse.json({ ok: true, action: parsed.data.action, correlationId: correlation });
  } catch (error) {
    return apiError("LITELLM_LIFECYCLE_FAILED", error instanceof Error ? error.message : "LiteLLM lifecycle operation failed", 502, correlation);
  }
}

async function adopt(adapter: HttpLiteLLMAdapter, deployment: typeof modelDeployments.$inferSelect, providerSlug: string, correlation: string) {
  const db = getDb();
  const plan = planAdoption({ managed: deployment.managed, lifecycle: deployment.lifecycle, litellmDeploymentId: deployment.litellmDeploymentId, providerSlug });
  if (!plan.allowed) return apiError("ADOPTION_NOT_ALLOWED", plan.reason, 409, correlation);

  const info = deployment.rawMetadata?.model_info as Record<string, unknown> | undefined;
  const previousOwner = typeof info?.managed_by === "string" ? info.managed_by : null;
  const result = await adoptDeployment(adapter, deployment.litellmDeploymentId!, previousOwner);

  // Record the attempt either way: an adoption that had to be rolled back is exactly what an operator needs to be able to find.
  await db.insert(auditEvents).values({
    actor: "admin", action: result.ok ? "litellm.deployment.adopted" : "litellm.deployment.adopt_failed", entityType: "model_deployment", entityId: deployment.id,
    before: { litellmDeploymentId: deployment.litellmDeploymentId, managedBy: previousOwner, modelInfo: result.ok ? sanitizedMetadata({ model_info: result.before } as never) : null },
    after: result.ok ? { managedBy: CURATOR_MANAGED_BY } : { stage: result.stage, message: result.message, restored: result.restored ?? null, lostKeys: result.lostKeys ?? [] },
    correlationId: correlation,
  });
  if (!result.ok) return apiError("ADOPTION_FAILED", result.message, 502, correlation);

  await db.update(modelDeployments).set({
    managed: true, managedBy: CURATOR_MANAGED_BY,
    rawMetadata: { ...deployment.rawMetadata, model_info: { ...(info ?? {}), ...result.after } }, updatedAt: new Date(),
  }).where(eq(modelDeployments.id, deployment.id));
  return NextResponse.json({ ok: true, action: "adopt", adoptedFrom: previousOwner, correlationId: correlation });
}

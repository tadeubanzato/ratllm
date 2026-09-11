import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { auditEvents, modelDeployments } from "@/server/db/schema";
import { apiError, correlationId } from "@/server/http";
import { HttpLiteLLMAdapter } from "@/server/litellm/client";

const input = z.object({ action: z.enum(["deactivate", "reactivate", "delete"]), confirmation: z.string().min(1) });

/** Guarded only by the typed confirmation phrase — the same authorization boundary as every other mutating
 *  action in this app (promote, deactivate a provider, delete a source). Talking to LiteLLM itself is still
 *  gated by the master key configured in Settings → LiteLLM, which HttpLiteLLMAdapter reads server-side. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const correlation = correlationId(request);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_REQUEST", "A lifecycle action and confirmation are required", 400, correlation);
  const { id } = await params;
  const db = getDb();
  const deployment = (await db.select().from(modelDeployments).where(eq(modelDeployments.id, id)).limit(1))[0];
  if (!deployment) return apiError("DEPLOYMENT_NOT_FOUND", "Deployment does not exist in Curator inventory", 404, correlation);
  if (!deployment.litellmDeploymentId) return apiError("DEPLOYMENT_NOT_LIVE", "This deployment is no longer present in LiteLLM", 409, correlation);
  const expected = parsed.data.action === "delete" ? `DELETE ${deployment.litellmModelName}` : deployment.litellmModelName;
  if (parsed.data.confirmation !== expected) return apiError("CONFIRMATION_REQUIRED", `Type exactly: ${expected}`, 409, correlation);
  const before = { litellmDeploymentId: deployment.litellmDeploymentId, health: deployment.health, action: parsed.data.action };
  try {
    const adapter = new HttpLiteLLMAdapter();
    if (parsed.data.action === "delete") {
      await adapter.removeDeployment(deployment.litellmDeploymentId);
      await db.update(modelDeployments).set({ litellmDeploymentId: null, health: "UNAVAILABLE", rawMetadata: { ...deployment.rawMetadata, lifecycle: "REMOVED", removedAt: new Date().toISOString() }, updatedAt: new Date() }).where(eq(modelDeployments.id, id));
    } else {
      const blocked = parsed.data.action === "deactivate";
      await adapter.setDeploymentBlocked(deployment.litellmDeploymentId, blocked);
      await db.update(modelDeployments).set({ health: blocked ? "UNAVAILABLE" : "UNKNOWN", rawMetadata: { ...deployment.rawMetadata, lifecycle: blocked ? "DEACTIVATED" : "ACTIVE", blocked }, updatedAt: new Date() }).where(eq(modelDeployments.id, id));
    }
    await db.insert(auditEvents).values({ actor: "admin", action: `litellm.deployment.${parsed.data.action}`, entityType: "model_deployment", entityId: id, before, after: { alias: deployment.litellmModelName }, correlationId: correlation });
    return NextResponse.json({ ok: true, action: parsed.data.action, correlationId: correlation });
  } catch (error) {
    return apiError("LITELLM_LIFECYCLE_FAILED", error instanceof Error ? error.message : "LiteLLM lifecycle operation failed", 502, correlation);
  }
}

import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments } from "@/server/db/schema";

/** The deployment columns the lane flows need, for one provider. */
export function getDeploymentsForProvider(providerId: string) {
  return getDb().select({
    id: modelDeployments.id,
    providerId: modelDeployments.providerId,
    providerModelId: modelDeployments.providerModelId,
    litellmModelName: modelDeployments.litellmModelName,
    litellmDeploymentId: modelDeployments.litellmDeploymentId,
    health: modelDeployments.health,
    rawMetadata: modelDeployments.rawMetadata,
  }).from(modelDeployments).where(eq(modelDeployments.providerId, providerId));
}

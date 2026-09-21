import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { modelDeployments } from "@/server/db/schema";
import { getDeployment, getDeployments } from "@/server/queries";
import { syncLiteLLM } from "@/server/litellm/sync";
import { CURATOR_MANAGED_BY } from "@/lib/constants";

const item = (id: string, model: string) => ({ model_name: "smart-general", litellm_params: { model }, model_info: { id, managed_by: CURATOR_MANAGED_BY } });

describe("the deployments list reflects what is in LiteLLM", () => {
  it("leaves removed deployments out of every list and count, but still finds one by its own id", async () => {
    await syncLiteLLM({}, { listDeployments: async () => [item("live-1", "groq/llama-3.3-70b-versatile"), item("gone-1", "cerebras/llama3.1-8b")] } as never);
    const gone = (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, "gone-1")))[0];
    await getDb().update(modelDeployments).set({ lifecycle: "REMOVED" }).where(eq(modelDeployments.id, gone.id));

    const listed = await getDeployments();
    expect(listed.map(row => row.litellmDeploymentId)).toEqual(["live-1"]);
    // the detail page of a model that was removed still works
    expect((await getDeployment(gone.id))?.litellmDeploymentId).toBe("gone-1");
  });
});

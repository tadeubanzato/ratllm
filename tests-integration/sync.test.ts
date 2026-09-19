import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { modelDeployments } from "@/server/db/schema";
import { syncLiteLLM } from "@/server/litellm/sync";

const inventory = (...items: unknown[]) => ({ listDeployments: async () => items }) as never;
const item = (id: string | null, name = "smart-general", model = "groq/llama-3") =>
  ({ model_name: name, litellm_params: { model }, model_info: id ? { id } : {} });

const lifecycleById = async () =>
  Object.fromEntries((await getDb().select().from(modelDeployments)).map(row => [row.litellmDeploymentId, row.lifecycle]));

describe("syncLiteLLM inventory reconciliation", () => {
  it("stores deployments by their router ID and skips items that have none", async () => {
    const result = await syncLiteLLM({}, inventory(item("dep-1"), item("dep-2"), item(null)));
    expect(result).toMatchObject({ deployments: 3, identified: 2, identityMissing: 1 });
    expect(await lifecycleById()).toEqual({ "dep-1": "ACTIVE", "dep-2": "ACTIVE" });
  });

  it("removes a deployment that has left the router when the rest of the inventory is intact", async () => {
    await syncLiteLLM({}, inventory(item("dep-1"), item("dep-2")));
    await syncLiteLLM({}, inventory(item("dep-1")));
    expect(await lifecycleById()).toEqual({ "dep-1": "ACTIVE", "dep-2": "REMOVED" });
  });

  it("does not wipe live deployments on a single empty inventory", async () => {
    await syncLiteLLM({}, inventory(item("dep-1"), item("dep-2")));
    const result = await syncLiteLLM({}, inventory());
    expect(result).toMatchObject({ removalsSkipped: "empty_inventory_unconfirmed" });
    expect(await lifecycleById()).toEqual({ "dep-1": "ACTIVE", "dep-2": "ACTIVE" });
  });

  it("does not wipe live deployments when every returned item lacks an ID", async () => {
    await syncLiteLLM({}, inventory(item("dep-1")));
    const result = await syncLiteLLM({}, inventory(item(null), item(null)));
    expect(result).toMatchObject({ identified: 0, identityMissing: 2, removalsSkipped: "empty_inventory_unconfirmed" });
    expect(await lifecycleById()).toEqual({ "dep-1": "ACTIVE" });
  });

  it("believes a second consecutive empty inventory, so a genuinely emptied router converges", async () => {
    await syncLiteLLM({}, inventory(item("dep-1")));
    await syncLiteLLM({}, inventory());
    expect(await lifecycleById()).toEqual({ "dep-1": "ACTIVE" });
    await syncLiteLLM({}, inventory());
    expect(await lifecycleById()).toEqual({ "dep-1": "REMOVED" });
  });

  it("recovers from a skipped empty sync: the router coming back does not need any repair", async () => {
    await syncLiteLLM({}, inventory(item("dep-1")));
    await syncLiteLLM({}, inventory());
    await syncLiteLLM({}, inventory(item("dep-1")));
    expect(await lifecycleById()).toEqual({ "dep-1": "ACTIVE" });
  });

  it("a dry run never writes", async () => {
    await syncLiteLLM({ dryRun: true }, inventory(item("dep-1")));
    expect(await getDb().select().from(modelDeployments)).toHaveLength(0);
  });
});

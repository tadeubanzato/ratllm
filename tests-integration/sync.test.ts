import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

describe("provider attribution for RatLLM-managed deployments", () => {
  // A source-provider name that resolves to nothing in the catalog, so attribution genuinely has to fall back to the route prefix.
  const UNLISTED_PROVIDER = "Some Unlisted Gateway";
  const managedItem = (id: string, candidateId: string, sourceProvider: string) =>
    ({ model_name: "smart-summary", litellm_params: { model: "openai/qwen-flash" }, model_info: { id, managed_by: "ratllm-curator", source_provider: sourceProvider, source_candidate_id: candidateId } });

  async function candidateFor(providerName: string) {
    const { modelCandidates, providers: providersTable } = await import("@/server/db/schema");
    const db = getDb();
    const [provider] = await db.insert(providersTable).values({ slug: "alibaba-model-studio", name: providerName, adapterKey: "manual", adapterCapability: "MANUAL" }).returning();
    const [candidate] = await db.insert(modelCandidates).values({ source: "models_dev", modelRef: "qwen-flash", displayName: "qwen-flash", sourceUrl: "u", providerId: provider.id }).returning();
    return { provider, candidate };
  }
  const providerNameOf = async (routerId: string) => {
    const { providers: providersTable } = await import("@/server/db/schema");
    const row = (await getDb().select().from(modelDeployments).where(eq(modelDeployments.litellmDeploymentId, routerId)))[0];
    return (await getDb().select().from(providersTable).where(eq(providersTable.id, row.providerId)))[0].name;
  };

  it("files the deployment under its discovery record's provider, even when the provider NAME doesn't match the catalog", async () => {
    const { candidate } = await candidateFor("Alibaba Model Studio");
    // The deployment calls its provider "Alibaba Cloud Model Studio"; only its route prefix says "openai".
    await syncLiteLLM({}, inventory(managedItem("q1", candidate.id, "Alibaba Cloud Model Studio")));
    expect(await providerNameOf("q1")).toBe("Alibaba Model Studio");
  });

  it("corrects a deployment that an earlier sync had filed under the catch-all provider", async () => {
    // First sync happens before the discovery record exists → falls back to the route prefix ("Openai").
    const missing = "00000000-0000-4000-8000-0000000000aa";
    await syncLiteLLM({}, inventory(managedItem("q1", missing, UNLISTED_PROVIDER)));
    expect(await providerNameOf("q1")).toBe("Openai");
    const { candidate } = await candidateFor("Alibaba Model Studio");
    await syncLiteLLM({}, inventory(managedItem("q1", candidate.id, "Alibaba Cloud Model Studio")));
    expect(await providerNameOf("q1")).toBe("Alibaba Model Studio");
  });

  it("falls back to name/prefix matching when the candidate id is unknown or malformed", async () => {
    await syncLiteLLM({}, inventory(managedItem("q1", "not-a-uuid", UNLISTED_PROVIDER), managedItem("q2", "00000000-0000-4000-8000-0000000000bb", UNLISTED_PROVIDER)));
    expect(await providerNameOf("q1")).toBe("Openai");
    expect(await providerNameOf("q2")).toBe("Openai");
  });

  it("resolves a catalogued provider by its display name when there is no usable candidate id", async () => {
    // "Alibaba Cloud Model Studio" is the catalog's own name for the provider, so it must not fall to the catch-all
    // just because its route prefix says "openai" and its name isn't spelled like its slug.
    await syncLiteLLM({}, inventory(managedItem("q1", "not-a-uuid", "Alibaba Cloud Model Studio")));
    expect(await providerNameOf("q1")).toBe("Alibaba Cloud Model Studio");
  });

  it("does not let an unmanaged deployment pick a provider from a candidate id it happens to carry", async () => {
    const { candidate } = await candidateFor("Alibaba Model Studio");
    const foreign = { ...managedItem("q1", candidate.id, "x"), model_info: { id: "q1", managed_by: "smart-free-sync", source_candidate_id: candidate.id } };
    await syncLiteLLM({}, inventory(foreign));
    expect(await providerNameOf("q1")).toBe("Openai");
  });
});

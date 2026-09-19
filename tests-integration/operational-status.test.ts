import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { providerCredentialReferences, providers, syncRuns } from "@/server/db/schema";
import { getOperationalStatus } from "@/server/operational-status";
import { writeWorkerHeartbeat } from "@/server/worker-heartbeat";
import { recordConnection } from "@/server/settings/connections";
import { syncLiteLLM } from "@/server/litellm/sync";
import { encryptCredential } from "@/server/credentials/crypto";

const inventory = (...items: unknown[]) => ({ listDeployments: async () => items }) as never;
const item = (id: string) => ({ model_name: "smart-agent", litellm_params: { model: "groq/llama-3.3-70b-versatile" }, model_info: { id } });
const run = (type: string, status: "SUCCEEDED" | "FAILED", finishedAt = new Date()) =>
  getDb().insert(syncRuns).values({ type, status, correlationId: `${type}-${status}-${finishedAt.getTime()}`, finishedAt });

/** A system where everything is working. */
async function healthySystem() {
  await writeWorkerHeartbeat("test-worker");
  await recordConnection("litellm", { ok: true, deploymentCount: 1 });
  for (const type of ["MODEL_DISCOVERY", "HEALTH_MONITOR", "CANDIDATE_VERIFICATION"]) await run(type, "SUCCEEDED");
  await syncLiteLLM({}, inventory(item("router-1")));      // records a LITELLM_SYNC success and one live deployment
}

describe("getOperationalStatus", () => {
  it("reports an empty, never-run system as degraded, with the reasons", async () => {
    const result = await getOperationalStatus();
    expect(result.status).toBe("degraded");
    const areas = result.reasons.map(reason => reason.area);
    expect(areas).toContain("worker");
    expect(areas).toContain("freshness");
    expect(areas).toContain("fleet");
  });

  it("is healthy when the worker beats, LiteLLM answers, data is fresh, and nothing has failed", async () => {
    await healthySystem();
    const result = await getOperationalStatus();
    expect(result.reasons.filter(reason => reason.severity === "degraded")).toEqual([]);
    expect(result.status).toBe("healthy");
    expect(result.facts.fleet.live).toBe(1);
  });

  it("degrades on a stale data source", async () => {
    await healthySystem();
    await getDb().delete(syncRuns);                                      // no run has ever succeeded
    await run("HEALTH_MONITOR", "SUCCEEDED", new Date(Date.now() - 5 * 3_600_000)); // 5h ago; expected hourly
    const result = await getOperationalStatus();
    expect(result.status).toBe("degraded");
    expect(result.reasons.some(reason => reason.area === "freshness" && /Health monitor last succeeded 5 h ago/.test(reason.message))).toBe(true);
  });

  it("degrades on a recent failed run and on an invalid credential, and only mentions unverified ones", async () => {
    await healthySystem();
    await run("MODEL_DISCOVERY", "FAILED");
    const provider = (await getDb().select().from(providers))[0];
    await getDb().insert(providerCredentialReferences).values([
      { providerId: provider.id, environmentVariable: "A_KEY", encryptedValue: encryptCredential("fake-a-0123456789"), valid: false },
      { providerId: provider.id, environmentVariable: "B_KEY", encryptedValue: encryptCredential("fake-b-0123456789"), valid: null },
    ]);
    const result = await getOperationalStatus();
    expect(result.status).toBe("degraded");
    expect(result.facts.failedRuns24h).toEqual({ MODEL_DISCOVERY: 1 });
    expect(result.facts.credentials).toEqual({ invalid: 1, unverified: 1 });
    expect(result.reasons.find(reason => reason.area === "credentials" && reason.severity === "info")).toBeDefined();
  });

  it("never includes a credential value or ciphertext in what it returns", async () => {
    await healthySystem();
    const provider = (await getDb().select().from(providers))[0];
    await getDb().insert(providerCredentialReferences).values({ providerId: provider.id, environmentVariable: "A_KEY", encryptedValue: encryptCredential("fake-secret-value-0123456789"), valid: true });
    const everything = JSON.stringify(await getOperationalStatus());
    expect(everything).not.toContain("fake-secret-value");
    expect(everything).not.toMatch(/v[12]\.[A-Za-z0-9_-]{8,}/);
  });
});

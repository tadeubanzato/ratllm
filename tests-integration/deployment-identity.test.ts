import { afterEach, describe, expect, it } from "vitest";
import { ensureDeploymentIdentity, getDeploymentIdentity } from "@/server/deployment-identity";
import { getOperationalStatus } from "@/server/operational-status";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

describe("database identity", () => {
  it("is absent until seeded, then created once and never changed", async () => {
    expect(await getDeploymentIdentity()).toBeNull();
    await ensureDeploymentIdentity();
    const first = await getDeploymentIdentity();
    expect(first!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first!.short).toBe(first!.id.slice(0, 8));
    await ensureDeploymentIdentity();
    await ensureDeploymentIdentity();
    expect((await getDeploymentIdentity())!.id).toBe(first!.id);        // re-seeding on every start must not rotate it
  });

  it("is what an operator compares: the status shows this database's id and where the app is pointed", async () => {
    await ensureDeploymentIdentity();
    const { environment } = await getOperationalStatus();
    expect(environment.databaseId).toBe((await getDeploymentIdentity())!.short);
    expect(environment.summary).toContain("database");
    expect(environment.summary).not.toMatch(/test@|password|:test/);      // no credentials, ever
  });
});

describe("environment problems reach the status", () => {
  it("degrades a remote-mode workstation whose DATABASE_URL points at the local container", async () => {
    process.env.RATLLM_DEPLOYMENT_MODE = "workstation-remote";
    process.env.DATABASE_URL = process.env.DATABASE_URL!.replace(/@[^/]+/, "@curator-db:5432");   // only what the status reads; the open connection is unaffected
    const result = await getOperationalStatus();
    const problem = result.reasons.find(reason => reason.area === "deployment");
    expect(problem).toMatchObject({ severity: "degraded" });
    expect(problem!.message).toMatch(/empty database instead of the server's data/);
    expect(result.status).toBe("degraded");
    expect(JSON.stringify(result)).not.toContain("test@curator-db");
  });

  it("reports no environment problem for a normal server", async () => {
    const result = await getOperationalStatus();
    expect(result.reasons.some(reason => reason.area === "deployment")).toBe(false);
  });
});

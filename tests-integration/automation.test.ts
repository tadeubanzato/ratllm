import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { leases, syncRuns } from "@/server/db/schema";
import { claim, release, renew, runAutomation } from "@/server/automation/service";

const leaseRow = async (type: string) => (await getDb().select().from(leases).where(eq(leases.key, `automation:${type}`)))[0];

describe("automation leases", () => {
  it("lets only one owner hold a job at a time", async () => {
    expect(await claim("HEALTH_MONITOR", "worker-a")).toBe(true);
    expect(await claim("HEALTH_MONITOR", "worker-b")).toBe(false);
  });

  it("lets a job be reclaimed once its lease has expired (crashed worker)", async () => {
    await claim("HEALTH_MONITOR", "worker-a");
    await getDb().update(leases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(leases.key, "automation:HEALTH_MONITOR"));
    expect(await claim("HEALTH_MONITOR", "worker-b")).toBe(true);
    expect((await leaseRow("HEALTH_MONITOR")).owner).toBe("worker-b");
  });

  it("renewal keeps a long-running job's lease from expiring", async () => {
    await claim("HEALTH_MONITOR", "worker-a");
    // Simulate a job that has run almost the full lease: 5 seconds left.
    await getDb().update(leases).set({ expiresAt: new Date(Date.now() + 5_000) }).where(eq(leases.key, "automation:HEALTH_MONITOR"));
    expect(await renew("HEALTH_MONITOR", "worker-a")).toBe(true);
    expect((await leaseRow("HEALTH_MONITOR")).expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(await claim("HEALTH_MONITOR", "worker-b")).toBe(false);
  });

  it("does not let a worker that lost its lease renew someone else's", async () => {
    await claim("HEALTH_MONITOR", "worker-a");
    await getDb().update(leases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(leases.key, "automation:HEALTH_MONITOR"));
    await claim("HEALTH_MONITOR", "worker-b");
    expect(await renew("HEALTH_MONITOR", "worker-a")).toBe(false);
    expect((await leaseRow("HEALTH_MONITOR")).owner).toBe("worker-b");
  });

  it("release only removes the caller's own lease", async () => {
    await claim("HEALTH_MONITOR", "worker-a");
    await release("HEALTH_MONITOR", "worker-b");
    expect(await leaseRow("HEALTH_MONITOR")).toBeDefined();
    await release("HEALTH_MONITOR", "worker-a");
    expect(await leaseRow("HEALTH_MONITOR")).toBeUndefined();
  });

  it("runAutomation refuses to start a job another worker is running", async () => {
    await claim("LANE_RECONCILE", "worker-a");
    expect(await runAutomation("LANE_RECONCILE")).toEqual({ started: false, reason: "already_running" });
  });
});

describe("run outcomes", () => {
  it("accepts the PARTIAL and DEFERRED statuses (migration 0012)", async () => {
    const db = getDb();
    for (const status of ["PARTIAL", "DEFERRED"] as const) {
      const [row] = await db.insert(syncRuns).values({ type: "CANDIDATE_PROMOTE", status, correlationId: `c-${status}` }).returning();
      expect(row.status).toBe(status);
    }
  });
});

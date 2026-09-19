import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { automationJobs, leases, syncRuns } from "@/server/db/schema";
import { claim, release, requestRun, tickScheduler } from "@/server/automation/service";
import { writeWorkerHeartbeat } from "@/server/worker-heartbeat";
import { POST as runNow } from "@/app/api/settings/automation/run/route";
import { GET as listJobs } from "@/app/api/settings/automation/route";

const job = async (type: string) => (await getDb().select().from(automationJobs).where(eq(automationJobs.type, type)))[0];
const runsOf = async (type: string) => getDb().select().from(syncRuns).where(eq(syncRuns.type, type));
const post = (body: unknown) => runNow(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }));

describe("requestRun / tickScheduler", () => {
  it("records the request without running anything", async () => {
    const result = await requestRun("MAINTENANCE");
    expect(result).toEqual({ queued: true, alreadyQueued: false });
    expect((await job("MAINTENANCE")).runRequestedAt).toBeInstanceOf(Date);
    expect(await runsOf("MAINTENANCE")).toHaveLength(0);
  });

  it("keeps the original request time when asked twice, and reports it was already queued", async () => {
    await requestRun("MAINTENANCE");
    const first = (await job("MAINTENANCE")).runRequestedAt!.getTime();
    expect(await requestRun("MAINTENANCE")).toEqual({ queued: true, alreadyQueued: true });
    expect((await job("MAINTENANCE")).runRequestedAt!.getTime()).toBe(first);
  });

  it("the worker's tick runs a requested job even though it isn't due, then clears the request", async () => {
    await requestRun("MAINTENANCE");
    const results = await tickScheduler();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fulfilled");
    const after = await job("MAINTENANCE");
    expect(after).toMatchObject({ runRequestedAt: null, requestedOptions: null, status: "SUCCEEDED" });
    const runs = await runsOf("MAINTENANCE");
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("SUCCEEDED");
    expect((runs[0].summary as { trigger: string }).trigger).toBe("MANUAL");   // recorded as a manual run, not a scheduled one
  });

  it("runs a requested job even when its schedule is disabled", async () => {
    await requestRun("MAINTENANCE");
    await getDb().update(automationJobs).set({ enabled: false }).where(eq(automationJobs.type, "MAINTENANCE"));
    await tickScheduler();
    expect(await runsOf("MAINTENANCE")).toHaveLength(1);
  });

  it("does not run jobs nobody asked for and that aren't due", async () => {
    await requestRun("MAINTENANCE");
    await tickScheduler();
    expect((await getDb().select().from(syncRuns)).map(run => run.type)).toEqual(["MAINTENANCE"]);   // nothing else started
  });

  it("carries the requested options through and clears them once started", async () => {
    await requestRun("CANDIDATE_VERIFICATION", { candidateScope: "connected" });
    expect((await job("CANDIDATE_VERIFICATION")).requestedOptions).toEqual({ candidateScope: "connected" });
    await tickScheduler();
    expect((await job("CANDIDATE_VERIFICATION")).requestedOptions).toBeNull();
  });

  it("leaves the request waiting while another worker holds the job, and runs it once that finishes", async () => {
    await requestRun("MAINTENANCE");
    await claim("MAINTENANCE", "another-worker");
    await tickScheduler();
    expect(await runsOf("MAINTENANCE")).toHaveLength(0);
    expect((await job("MAINTENANCE")).runRequestedAt).not.toBeNull();     // still waiting, not lost
    await release("MAINTENANCE", "another-worker");
    await tickScheduler();
    expect(await runsOf("MAINTENANCE")).toHaveLength(1);
    expect((await job("MAINTENANCE")).runRequestedAt).toBeNull();
  });

  it("a request made during a scheduled run is satisfied by the next tick, not dropped", async () => {
    await claim("MAINTENANCE", "busy");
    await requestRun("MAINTENANCE");
    await tickScheduler();                                                  // held: waits
    await getDb().delete(leases).where(eq(leases.key, "automation:MAINTENANCE"));
    await tickScheduler();
    expect((await job("MAINTENANCE")).runRequestedAt).toBeNull();
  });
});

describe("POST /api/settings/automation/run", () => {
  it("returns 202 immediately without running the job, and says whether a worker is alive", async () => {
    let response = await post({ type: "MAINTENANCE" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ queued: true, workerAlive: false });   // no heartbeat yet
    expect(await runsOf("MAINTENANCE")).toHaveLength(0);                                  // nothing ran inside the request
    await writeWorkerHeartbeat("test-worker");
    response = await post({ type: "MAINTENANCE" });
    expect(await response.json()).toMatchObject({ queued: true, alreadyQueued: true, workerAlive: true });
  });

  it("rejects an unknown job or a malformed body", async () => {
    expect((await post({ type: "NOT_A_JOB" })).status).toBe(400);
    expect((await runNow(new Request("http://x/api", { method: "POST", body: "nope" }))).status).toBe(400);
  });

  it("the jobs list shows the pending request and each job's latest run", async () => {
    await post({ type: "MAINTENANCE" });
    let rows = await (await listJobs()).json() as Array<{ type: string; runRequestedAt: string | null; lastRun: { status: string } | null }>;
    expect(rows.find(row => row.type === "MAINTENANCE")).toMatchObject({ lastRun: null });
    expect(rows.find(row => row.type === "MAINTENANCE")!.runRequestedAt).not.toBeNull();
    await tickScheduler();
    rows = await (await listJobs()).json();
    const done = rows.find(row => row.type === "MAINTENANCE")!;
    expect(done.runRequestedAt).toBeNull();
    expect(done.lastRun).toMatchObject({ status: "SUCCEEDED" });
  });
});

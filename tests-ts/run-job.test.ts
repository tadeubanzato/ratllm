import { describe, expect, it } from "vitest";
import { waitForJob, type JobSnapshot, type RunPhase } from "../src/lib/run-job";

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({ type: "MAINTENANCE", status: "IDLE", runRequestedAt: null, lastError: null, lastRun: null, ...over });

/** Feed `waitForJob` a scripted sequence of job states, one per poll, on a fake clock. */
function harness(script: Array<Partial<JobSnapshot> | "gone">, tickMs = 2500) {
  let poll = 0, clock = 0;
  const phases: RunPhase[] = [];
  const deps = {
    fetchJobs: async () => { const step = script[Math.min(poll++, script.length - 1)]; return step === "gone" ? [] : [job(step)]; },
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    onPhase: (phase: RunPhase) => phases.push(phase),
  };
  return { deps, phases, polls: () => poll, advance: (ms: number) => { clock += ms; }, tickMs };
}

describe("waitForJob", () => {
  it("follows queued -> running -> succeeded and reports the job's own summary", async () => {
    const h = harness([
      { runRequestedAt: "2026-09-19T00:00:00Z" },
      { runRequestedAt: null, status: "RUNNING" },
      { status: "SUCCEEDED", lastRun: { status: "SUCCEEDED", summary: { trigger: "MANUAL", result: { processed: 12, available: 9 } }, error: null, finishedAt: "x" } },
    ]);
    const outcome = await waitForJob("MAINTENANCE", h.deps);
    expect(outcome).toEqual({ state: "succeeded", summary: { processed: 12, available: 9 }, message: null });
    expect(h.phases).toEqual(["queued", "running"]);
  });

  it("reports a failure with the job's own error", async () => {
    const outcome = await waitForJob("MAINTENANCE", harness([{ status: "RUNNING" }, { status: "FAILED", lastError: "LiteLLM unreachable" }]).deps);
    expect(outcome).toMatchObject({ state: "failed", message: "LiteLLM unreachable" });
  });

  it("does not call it finished while the request is still waiting for a worker, however long that takes", async () => {
    const h = harness([{ status: "SUCCEEDED", runRequestedAt: "t" }, { status: "SUCCEEDED", runRequestedAt: "t" }, { status: "SUCCEEDED", runRequestedAt: "t" }, { status: "SUCCEEDED" }]);
    const outcome = await waitForJob("MAINTENANCE", h.deps);
    expect(outcome.state).toBe("succeeded");
    expect(h.polls()).toBe(4);                  // kept waiting through the stale SUCCEEDED from the previous run
    expect(h.phases).toEqual(["queued"]);
  });

  it("gives up after the timeout instead of waiting forever, and says the job keeps running", async () => {
    const h = harness([{ runRequestedAt: "t" }]);   // no worker ever picks it up
    const outcome = await waitForJob("MAINTENANCE", h.deps, { intervalMs: 1000, timeoutMs: 5000 });
    expect(outcome.state).toBe("timeout");
    expect(outcome.message).toMatch(/keeps running|Runs page/);
    expect(h.polls()).toBeLessThanOrEqual(7);   // bounded
  });

  it("only reports each phase once", async () => {
    const h = harness([{ runRequestedAt: "t" }, { runRequestedAt: "t" }, { status: "RUNNING" }, { status: "RUNNING" }, { status: "SUCCEEDED" }]);
    await waitForJob("MAINTENANCE", h.deps);
    expect(h.phases).toEqual(["queued", "running"]);
  });

  it("reads a self-logging job's summary directly (no result wrapper)", async () => {
    const outcome = await waitForJob("MODEL_DISCOVERY", { ...harness([{ type: "MODEL_DISCOVERY", status: "SUCCEEDED", lastRun: { status: "SUCCEEDED", summary: { discovered: 40 }, error: null, finishedAt: "x" } }]).deps });
    expect(outcome.summary).toEqual({ discovered: 40 });
  });

  it("fails cleanly if the job no longer exists", async () => {
    expect(await waitForJob("MAINTENANCE", harness(["gone"]).deps)).toMatchObject({ state: "failed" });
  });
});

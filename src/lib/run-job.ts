/** What GET /api/settings/automation returns for one job (only the fields the "run now" flow needs). */
export interface JobSnapshot {
  type: string;
  status: string;
  runRequestedAt: string | null;
  lastError: string | null;
  lastRun: { status: string; summary: Record<string, unknown> | null; error: string | null; finishedAt: string | null } | null;
}

export type RunPhase = "queued" | "running";
export interface RunOutcome {
  state: "succeeded" | "failed" | "timeout";
  /** The job's own result (counts etc.) when it reported one. */
  summary: Record<string, unknown> | null;
  message: string | null;
}

export interface WaitDeps {
  fetchJobs: () => Promise<JobSnapshot[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onPhase?: (phase: RunPhase) => void;
}

/** A wrapped job stores `{trigger, result}`; the self-logging ones (discovery, lane reconcile) store their summary directly. */
const summaryOf = (run: JobSnapshot["lastRun"]) => {
  const summary = run?.summary ?? null;
  return summary && typeof summary.result === "object" && summary.result !== null ? summary.result as Record<string, unknown> : summary;
};

/**
 * After "Run now" has been queued, follow the job until it is done: still requested = waiting for the worker; RUNNING = in
 * progress; neither = finished, and its status says how. A request clears in the same update that marks the job RUNNING, so
 * there is no moment where a finished-looking job hasn't actually run.
 */
export async function waitForJob(type: string, deps: WaitDeps, options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<RunOutcome> {
  const intervalMs = options.intervalMs ?? 2500;
  const deadline = deps.now() + (options.timeoutMs ?? 20 * 60_000);
  let phase: RunPhase | null = null;
  for (;;) {
    const job = (await deps.fetchJobs()).find(item => item.type === type);
    if (!job) return { state: "failed", summary: null, message: "That job no longer exists." };
    if (job.runRequestedAt || job.status === "RUNNING") {
      const next: RunPhase = job.runRequestedAt ? "queued" : "running";
      if (next !== phase) { phase = next; deps.onPhase?.(next); }
    } else if (job.status === "FAILED") {
      return { state: "failed", summary: summaryOf(job.lastRun), message: job.lastError ?? job.lastRun?.error ?? "The job failed." };
    } else {
      return { state: "succeeded", summary: summaryOf(job.lastRun), message: null };
    }
    if (deps.now() >= deadline) return { state: "timeout", summary: null, message: "Still not finished — it keeps running in the background. Check the Runs page." };
    await deps.sleep(intervalMs);
  }
}

/** Browser wiring: queue the run (returns at once), then follow it. */
export async function runJobAndWait(type: string, options: { scope?: "due" | "connected"; onPhase?: (phase: RunPhase) => void; onQueued?: (info: { workerAlive: boolean; alreadyQueued: boolean }) => void } = {}): Promise<RunOutcome> {
  const response = await fetch("/api/settings/automation/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, scope: options.scope }) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? "Could not queue the run");
  options.onQueued?.({ workerAlive: Boolean(body.workerAlive), alreadyQueued: Boolean(body.alreadyQueued) });
  return waitForJob(type, {
    fetchJobs: async () => { const r = await fetch("/api/settings/automation", { cache: "no-store" }); if (!r.ok) throw new Error("Could not read job status"); return r.json(); },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    onPhase: options.onPhase,
  });
}

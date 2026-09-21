import { healthFromSmokeResult } from "./status";

/** A deployment's own newest probe. */
export interface LatestProbe { status: string; httpStatus: number | null; latencyMs: number | null; error: string | null; createdAt: Date }
export interface PerformanceStatLike { successRate: number; p50LatencyMs: number | null; avgFirstTokenMs: number | null }

export interface PerformanceRow<D, S extends PerformanceStatLike = PerformanceStatLike> { d: D; t: LatestProbe | null; displayStatus: string; stat: S | null }

/** How recently a deployment must have been probed to count as "checked" in the coverage figure. */
export const COVERAGE_WINDOW_MS = 24 * 60 * 60_000;

/** Effectiveness, not just current status: highest success rate over real sample history first (a model passing 95% of its last 20 checks
 *  beats one that merely happens to be HEALTHY on its single latest check), then lowest p50 latency, then lowest first-token time. A
 *  deployment with no stats yet sorts last. */
export function comparePerformanceRows(a: { stat: PerformanceStatLike | null }, b: { stat: PerformanceStatLike | null }): number {
  if (!a.stat && !b.stat) return 0;
  if (!a.stat) return 1;
  if (!b.stat) return -1;
  if (a.stat.successRate !== b.stat.successRate) return b.stat.successRate - a.stat.successRate;
  const ap50 = a.stat.p50LatencyMs, bp50 = b.stat.p50LatencyMs;
  if (ap50 !== bp50) { if (ap50 == null) return 1; if (bp50 == null) return -1; return ap50 - bp50; }
  const aFtt = a.stat.avgFirstTokenMs, bFtt = b.stat.avgFirstTokenMs;
  if (aFtt !== bFtt) { if (aFtt == null) return 1; if (bFtt == null) return -1; return aFtt - bFtt; }
  return 0;
}

/** One row per deployment: its latest probe, what that probe means, and its recent-history stats. The deployment list is the source of
 *  truth for WHAT is shown; a deployment with no probe yet is "NOT_RUN", never silently left out. */
export function buildPerformanceRows<D extends { id: string }, S extends PerformanceStatLike>(deployments: readonly D[], latest: ReadonlyMap<string, LatestProbe>, stats: ReadonlyMap<string, S>): Array<PerformanceRow<D, S>> {
  return deployments.map(d => {
    const t = latest.get(d.id) ?? null;
    const displayStatus = t ? healthFromSmokeResult(t.status === "PASSED", t.httpStatus ?? 0, t.latencyMs ?? 0, t.error ?? undefined) : "NOT_RUN";
    return { d, t, displayStatus, stat: stats.get(d.id) ?? null };
  }).sort(comparePerformanceRows);
}

/** The strip above the table. Coverage is "probed in the last 24 hours", worked out from each deployment's OWN latest probe. */
export function summarizePerformance(rows: ReadonlyArray<{ t: LatestProbe | null; displayStatus: string }>, now = Date.now()) {
  return {
    deployments: rows.length,
    checkedLast24h: rows.filter(row => row.t && now - row.t.createdAt.getTime() <= COVERAGE_WINDOW_MS).length,
    passed: rows.filter(row => row.displayStatus === "HEALTHY").length,
    failed: rows.filter(row => row.displayStatus !== "HEALTHY" && row.displayStatus !== "NOT_RUN").length,
    awaitingFirstProbe: rows.filter(row => row.displayStatus === "NOT_RUN").length,
  };
}

/** How long each kind of run may go without a success before its data is considered stale: its schedule plus a grace period. */
export const FRESHNESS_LIMITS_MS: Record<string, number> = {
  MODEL_DISCOVERY: 6 * 60 * 60_000 + 30 * 60_000,       // every 6 hours
  HEALTH_MONITOR: 60 * 60_000 + 30 * 60_000,            // hourly
  LITELLM_SYNC: 60 * 60_000 + 30 * 60_000,              // inventory sync, hourly
  CANDIDATE_VERIFICATION: 60 * 60_000 + 30 * 60_000,    // hourly
};

/** LiteLLM is re-confirmed each time the hourly health monitor or inventory sync runs, so "recently" must span more than one cycle.
 *  (The connection's own STALE flag trips after 15 minutes, which would read as a problem for ~45 minutes of every hour.) */
export const LITELLM_CONFIRMATION_LIMIT_MS = 2 * 60 * 60_000;

const LABEL: Record<string, string> = { MODEL_DISCOVERY: "Model discovery", HEALTH_MONITOR: "Health monitor", LITELLM_SYNC: "LiteLLM inventory sync", CANDIDATE_VERIFICATION: "Candidate verification" };

import type { DeploymentProblem } from "./deployment-info";

export interface StatusInput {
  now: number;
  worker: { status: "alive" | "stale" | "absent"; heartbeatAgeMs: number | null; overdueJobs: number } | null;
  litellm: { status: string; lastSuccessAt: number | null; error: string | null } | null;
  lastSuccessAt: Record<string, number | null>;
  failedRuns24h: Record<string, number>;
  credentials: { invalid: number; unverified: number };
  fleet: { live: number; notServing: number; unmanagedNotServing: number };
  /** Problems with the environment itself (wrong mode for the database, missing DATABASE_URL). */
  deployment?: { problems: DeploymentProblem[] };
}

export interface StatusReason { severity: "degraded" | "info"; area: "worker" | "litellm" | "freshness" | "runs" | "credentials" | "fleet" | "deployment"; message: string }

const minutes = (ms: number) => ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`;

/**
 * `healthy` only when nothing needs attention; otherwise `degraded` with a plain-language reason per problem. A missing
 * dependency must read as degraded, never as a generic green: this system used to report "healthy" while its worker was
 * stopped and LiteLLM was unreachable.
 */
export function evaluateStatus(input: StatusInput): { status: "healthy" | "degraded"; reasons: StatusReason[] } {
  const reasons: StatusReason[] = [];
  const add = (severity: StatusReason["severity"], area: StatusReason["area"], message: string) => reasons.push({ severity, area, message });

  if (!input.worker || input.worker.status === "absent") add("degraded", "worker", "No worker has reported in — scheduled automation is not running.");
  else if (input.worker.status === "stale") add("degraded", "worker", `The worker last reported ${minutes(input.worker.heartbeatAgeMs ?? 0)} ago.`);
  else if (input.worker.overdueJobs > 0) add("degraded", "worker", `${input.worker.overdueJobs} scheduled job${input.worker.overdueJobs === 1 ? " is" : "s are"} overdue.`);

  if (!input.litellm || input.litellm.status === "NOT_CONFIGURED") add("degraded", "litellm", "LiteLLM is not configured.");
  else if (input.litellm.status === "UNAVAILABLE") add("degraded", "litellm", `LiteLLM is unreachable${input.litellm.error ? ` (${input.litellm.error})` : ""}.`);
  else if (input.litellm.lastSuccessAt === null || input.now - input.litellm.lastSuccessAt > LITELLM_CONFIRMATION_LIMIT_MS) add("degraded", "litellm", `LiteLLM has not been reached successfully in the last ${minutes(LITELLM_CONFIRMATION_LIMIT_MS)}.`);

  for (const [type, limit] of Object.entries(FRESHNESS_LIMITS_MS)) {
    const at = input.lastSuccessAt[type] ?? null;
    if (at === null) add("degraded", "freshness", `${LABEL[type] ?? type} has never completed successfully.`);
    else if (input.now - at > limit) add("degraded", "freshness", `${LABEL[type] ?? type} last succeeded ${minutes(input.now - at)} ago (expected within ${minutes(limit)}).`);
  }

  for (const [type, n] of Object.entries(input.failedRuns24h).sort(([a], [b]) => a.localeCompare(b))) {
    if (n > 0) add("degraded", "runs", `${LABEL[type] ?? type} failed ${n} time${n === 1 ? "" : "s"} in the last 24 hours.`);
  }

  if (input.credentials.invalid > 0) add("degraded", "credentials", `${input.credentials.invalid} provider credential${input.credentials.invalid === 1 ? " is" : "s are"} invalid.`);
  if (input.credentials.unverified > 0) add("info", "credentials", `${input.credentials.unverified} provider credential${input.credentials.unverified === 1 ? " has" : "s have"} not been verified yet.`);

  if (input.fleet.live === 0) add("degraded", "fleet", "No live deployments are recorded — inventory may never have been synced.");
  else {
    if (input.fleet.notServing > 0) add("info", "fleet", `${input.fleet.notServing} of ${input.fleet.live} live deployments are not serving${input.fleet.unmanagedNotServing ? ` (${input.fleet.unmanagedNotServing} not managed by RatLLM)` : ""}.`);
  }

  for (const problem of input.deployment?.problems ?? []) add(problem.severity, "deployment", problem.message);

  return { status: reasons.some(reason => reason.severity === "degraded") ? "degraded" : "healthy", reasons };
}

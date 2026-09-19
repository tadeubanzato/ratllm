import { SELF_HOSTED_PROVIDERS } from "@/server/providers/wiring";
import { NEUTRAL_ERROR_CODES } from "./probe-policy";

export const AUTO_REMOVE_AFTER_FAILURES = 5;

/** Auto-remove only ever touches a deployment this app added itself, and never a self-hosted one (local/MLX,
 *  Lemonade) even if it were somehow managed — a laptop asleep or a LAN hiccup looks identical to N failed checks,
 *  but it's the user's own machine being unreachable, not a dead model, and there's no discovery re-run that would
 *  ever bring a self-hosted deployment back after a wrongful removal. Also skips anything already DEACTIVATED or
 *  REMOVED (blocked at the router, whether by this app or an external tool, or already cleaned up) — there's
 *  nothing left to "auto-remove" and no reason to burn a misleading "5 consecutive failures" reason on it. */
export function isAutoRemoveEligible(deployment: { managed: boolean; litellmDeploymentId: string | null; lifecycle: string }, providerSlug: string): boolean {
  return deployment.managed && deployment.litellmDeploymentId !== null && deployment.lifecycle === "ACTIVE" && !SELF_HOSTED_PROVIDERS.has(providerSlug);
}

/** Pure streak logic, kept dependency-free for unit testing: most-recent-first smoke test rows in, consecutive-
 *  genuine-failure count out. Rows whose error code is neutral (see probe-policy.ts) neither count toward the streak
 *  nor break one already building from genuine failures:
 *    - a 429 proves the provider is alive and answering;
 *    - an auth error (401/403) is a credential problem, not a dead model — every deployment sharing that key fails
 *      the same way, and deleting them would punish the models for something only the operator can fix;
 *    - a failure recorded during a router-wide or provider-wide incident says nothing about this deployment.
 *  A truly broken deployment still can't dodge auto-remove by answering with one of these now and then. */
export function computeFailureStreak(recent: readonly { status: string; errorCode: string | null }[]): number {
  let streak = 0;
  for (const row of recent) {
    if (row.errorCode !== null && NEUTRAL_ERROR_CODES.has(row.errorCode)) continue;
    if (row.status !== "FAILED") break;
    if (++streak >= AUTO_REMOVE_AFTER_FAILURES) break;
  }
  return streak;
}

/** How a discovery run's overall status follows from its per-source outcomes. Pure, so it's unit-testable.
 *
 *  - Any failed source means the run did not fully succeed: PARTIAL if something else worked (or was merely waiting on a
 *    credential), FAILED if nothing did.
 *  - A BLOCKED source (credential not configured yet) is an expected waiting state, not a failure: it never degrades a run
 *    that otherwise did its job. If every source was blocked the run did nothing, which is DEFERRED rather than a success. */
export function discoveryRunStatus(counts: { succeeded: number; failed: number; blocked: number }): "SUCCEEDED" | "PARTIAL" | "FAILED" | "DEFERRED" {
  const { succeeded, failed, blocked } = counts;
  if (failed > 0) return succeeded > 0 || blocked > 0 ? "PARTIAL" : "FAILED";
  if (blocked > 0 && succeeded === 0) return "DEFERRED";
  return "SUCCEEDED";
}

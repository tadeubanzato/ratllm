export const AUTO_REMOVE_AFTER_FAILURES = 5;

/** Pure streak logic, kept dependency-free for unit testing: most-recent-first smoke test rows in, consecutive-
 *  genuine-failure count out. A 429 proves the provider is alive and answering — the opposite of evidence the
 *  deployment is dead — so it neither counts toward the streak nor breaks one already building from genuine
 *  failures (a truly broken deployment shouldn't dodge auto-remove just because it happens to answer with 429
 *  sometimes). */
export function computeFailureStreak(recent: readonly { status: string; errorCode: string | null }[]): number {
  let streak = 0;
  for (const row of recent) {
    if (row.errorCode === "RATE_LIMITED") continue;
    if (row.status !== "FAILED") break;
    if (++streak >= AUTO_REMOVE_AFTER_FAILURES) break;
  }
  return streak;
}

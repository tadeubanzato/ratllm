/** Pure scheduling primitives for the automation worker — no DB, no server-only, safe to unit-test in isolation. */

export const JOB_TYPES = ["MODEL_DISCOVERY", "CANDIDATE_VERIFICATION", "HEALTH_MONITOR", "RATE_LIMIT_LEARNING", "PROVIDER_VERIFICATION", "APPLY_APPROVED_PLANS", "DEEP_BENCHMARK", "LANE_RECONCILE", "MAINTENANCE"] as const;
export type AutomationType = typeof JOB_TYPES[number];

// See docs/FREE-MODEL-LIFECYCLE.md §4 for the rationale behind each cadence. CANDIDATE_VERIFICATION moved from
// every 6h to hourly so the fast-track recheck delay for unproven candidates (see discovery/auto-add-policy.ts)
// actually gets picked up promptly instead of being capped by a coarse cron window. APPLY_APPROVED_PLANS and
// LANE_RECONCILE are staggered off the top of the hour so they stop colliding with HEALTH_MONITOR, which also
// writes lane data (via recordLaneSnapshots) at :00 — three job types hitting DB + LiteLLM at the same instant
// bought nothing.
const DEFAULT_SCHEDULES: Record<AutomationType, string> = {
  MODEL_DISCOVERY: "0 */6 * * *",
  CANDIDATE_VERIFICATION: "20 * * * *",
  HEALTH_MONITOR: "0 * * * *",
  RATE_LIMIT_LEARNING: "30 */6 * * *",
  PROVIDER_VERIFICATION: "45 */6 * * *",
  APPLY_APPROVED_PLANS: "10 * * * *",
  DEEP_BENCHMARK: "0 3 * * *",
  LANE_RECONCILE: "5 * * * *",
  MAINTENANCE: "30 3 * * *",
};

/** The code-owned default schedule for a job. The DB row is healed back to this whenever the user has not explicitly customised it. */
export function defaultScheduleFor(type: AutomationType) { return DEFAULT_SCHEDULES[type]; }

/** Small, deliberately strict five-field cron evaluator. Invalid schedules are rejected rather than guessed. */
export function nextCron(schedule: string, from = new Date()): Date {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Schedule must be a five-field cron expression");
  const matches = (value: number, field: string, min: number, max: number) => field.split(",").some(part => {
    const [base, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    const accepts = (n: number) => base === "*" || (base.includes("-")
      ? (() => { const [a, b] = base.split("-").map(Number); return n >= a && n <= b; })()
      : n === Number(base));
    return value >= min && value <= max && accepts(value) && ((value - min) % step === 0);
  });
  const at = new Date(from);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  for (let i = 0; i < 527040; i++) {
    if (matches(at.getMinutes(), fields[0], 0, 59) && matches(at.getHours(), fields[1], 0, 23) && matches(at.getDate(), fields[2], 1, 31) && matches(at.getMonth() + 1, fields[3], 1, 12) && matches(at.getDay(), fields[4], 0, 6)) return at;
    at.setMinutes(at.getMinutes() + 1);
  }
  throw new Error("No next run found for cron expression");
}

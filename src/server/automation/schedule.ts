/** Pure scheduling primitives for the automation worker — no DB, no server-only, safe to unit-test in isolation. */

export const JOB_TYPES = ["MODEL_DISCOVERY", "CANDIDATE_VERIFICATION", "HEALTH_MONITOR", "RATE_LIMIT_LEARNING", "PROVIDER_VERIFICATION", "APPLY_APPROVED_PLANS", "DEEP_BENCHMARK", "LANE_RECONCILE", "MAINTENANCE", "GIGACHAT_TOKEN_REFRESH"] as const;
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
  // GigaChat's OAuth token expires every ~30 minutes (see providers/gigachat.ts) — refreshed well inside that
  // window so a missed or slow tick never lets a promoted deployment's key actually go stale.
  GIGACHAT_TOKEN_REFRESH: "*/10 * * * *",
};

/** The code-owned default schedule for a job. The DB row is healed back to this whenever the user has not explicitly customised it. */
export function defaultScheduleFor(type: AutomationType) { return DEFAULT_SCHEDULES[type]; }

export const DEFAULT_TIME_ZONE = "UTC";

export function isValidTimeZone(timeZone: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields a cron expression is matched against, for `date` as seen in `timeZone`. */
function wallClock(date: Date, timeZone: string) {
  if (timeZone === "UTC") return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() };
  let formatter = formatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" }); formatters.set(timeZone, formatter); }
  const get = (type: string) => formatter!.formatToParts(date).find(part => part.type === type)!.value;
  return { minute: Number(get("minute")), hour: Number(get("hour")), day: Number(get("day")), month: Number(get("month")), weekday: WEEKDAYS[get("weekday")] };
}

/**
 * Small, deliberately strict five-field cron evaluator. Invalid schedules are rejected rather than guessed.
 *
 * Fields are matched against the wall clock in `timeZone` (an IANA name, default UTC) — never the server process's own
 * zone, which used to decide silently. Time advances in real minutes, so DST behaves like classic cron: a local time
 * skipped by spring-forward (02:30 that day) doesn't occur and that day's run is skipped, and a repeated hour after
 * fall-back matches twice.
 */
export function nextCron(schedule: string, from = new Date(), timeZone = DEFAULT_TIME_ZONE): Date {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Schedule must be a five-field cron expression");
  if (!isValidTimeZone(timeZone)) throw new Error(`Unknown time zone: ${timeZone}`);
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
  at.setUTCSeconds(0, 0);
  at.setUTCMinutes(at.getUTCMinutes() + 1);
  for (let i = 0; i < 527040; i++) {
    const w = wallClock(at, timeZone);
    if (matches(w.minute, fields[0], 0, 59) && matches(w.hour, fields[1], 0, 23) && matches(w.day, fields[2], 1, 31) && matches(w.month, fields[3], 1, 12) && matches(w.weekday, fields[4], 0, 6)) return at;
    at.setUTCMinutes(at.getUTCMinutes() + 1);
  }
  throw new Error("No next run found for cron expression");
}

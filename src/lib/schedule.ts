export type ScheduleUnit = "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";

export const scheduleUnits: {value: ScheduleUnit; label: string}[] = [
  {value: "MINUTE", label: "Minute(s)"},
  {value: "HOUR", label: "Hour(s)"},
  {value: "DAY", label: "Day(s)"},
  {value: "WEEK", label: "Week(s)"},
  {value: "MONTH", label: "Month(s)"},
];

/** Builds a five-field cron expression for "every N <unit>". Week is approximated as N*7 days (resets at month boundaries, like most simple schedulers). */
export function scheduleToCron(n: number, unit: ScheduleUnit): string {
  switch (unit) {
    case "MINUTE": return `*/${n} * * * *`;
    case "HOUR": return `0 */${n} * * *`;
    case "DAY": return `0 0 */${n} * *`;
    case "WEEK": return `0 0 */${n * 7} * *`;
    case "MONTH": return `0 0 1 */${n} *`;
  }
}

function stepOrStar(field: string): number | null {
  if (field === "*") return 1;
  const match = /^\*\/(\d+)$/.exec(field);
  return match ? Number(match[1]) : null;
}

/**
 * Best-effort inverse of scheduleToCron. A minute offset on an hourly cron
 * (e.g. minute 15 on an every-6-hours schedule, used to stagger jobs so they
 * don't all fire at once) doesn't change the interval, so it's ignored
 * wherever the hour/day/month field alone already pins down "every N unit".
 * Returns null only when the expression carries information the simple
 * picker genuinely can't represent — a fixed time of day (daily at 3am,
 * say) — so the caller falls back to raw cron instead of silently
 * discarding that specific time on the next save.
 */
export function cronToSchedule(cron: string): {n: number; unit: ScheduleUnit} | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*" && minute !== "0") {
    const n = stepOrStar(minute);
    if (n) return {n, unit: "MINUTE"};
  }
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = stepOrStar(hour);
    if (n) return {n, unit: "HOUR"};
  }
  if (minute === "0" && hour === "0" && month === "*" && dayOfWeek === "*") {
    const n = stepOrStar(dayOfMonth);
    if (n) return n % 7 === 0 ? {n: n / 7, unit: "WEEK"} : {n, unit: "DAY"};
  }
  if (minute === "0" && hour === "0" && dayOfMonth === "1" && dayOfWeek === "*") {
    const n = stepOrStar(month);
    if (n) return {n, unit: "MONTH"};
  }
  return null;
}

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/** Placeholder for an already-configured secret field — reads as a masked value sitting there (like a password
 *  manager) instead of an empty-looking box with a sentence explaining it isn't. Never the real secret or its
 *  real length: the server never returns stored credentials at all, so this is a fixed-width stand-in, not a hint
 *  about what's actually stored. */
export const MASKED_SECRET_PLACEHOLDER = "•".repeat(16);

export function timeAgo(value: Date | string | null | undefined) {
  if (!value) return "Never";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400],
    ["hour", 3_600], ["minute", 60], ["second", 1],
  ];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size || unit === "second") return formatter.format(Math.round(seconds / size), unit);
  return "now";
}

export function duration(ms: number | null) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatSummaryValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? entries.map(([key, inner]) => `${key} ${formatSummaryValue(inner)}`).join(", ") : "—";
  }
  return String(value);
}

/** Renders a run/job summary object as a compact one-line string, recursing into nested objects instead of printing "[object Object]". */
export function formatSummary(summary: Record<string, unknown>): string {
  return Object.entries(summary).map(([key, value]) => `${key} ${formatSummaryValue(value)}`).join(" · ");
}

/** Coerces a timestamp column from a raw `db.execute()` into a Date.
 *
 *  Drizzle's query builder runs the driver's type parsers, so `select()` hands back real Dates; `execute()` does not,
 *  and postgres-js surfaces a timestamptz as its wire text ("2026-09-20 13:20:13.099062+00"). That string is not
 *  ISO-8601 — the space separator makes `new Date()` fall back to implementation-defined parsing, which V8 happens to
 *  get right and the spec does not require anyone to. Normalising it first keeps these history queries correct on
 *  their own terms instead of on V8's goodwill. */
export function historyTimestamp(value: Date | string): Date {
  if (value instanceof Date) return value;
  // "YYYY-MM-DD HH:MM:SS.ffffff+00" -> "YYYY-MM-DDTHH:MM:SS.ffffff+00:00", which every engine parses per spec.
  const iso = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? new Date(value) : parsed;
}

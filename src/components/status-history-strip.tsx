import Link from "next/link";

export type StatusHistoryState = "success" | "warning" | "failure" | "rate_limited" | "running" | "unknown";

export interface StatusHistoryItem {
  /** An observation time; it is intentionally optional for sparse history. */
  at?: Date | string | null;
  status: StatusHistoryState | string;
  label?: string;
  detail?: string;
  href?: string;
}

export const stateFor = (value: StatusHistoryItem["status"]): StatusHistoryState => {
  const normalized = value.toLowerCase().replaceAll(" ", "_");
  if (["success", "healthy", "passed", "pass", "completed", "succeeded", "applied", "verified", "available", "reachable", "ok", "up"].includes(normalized)) return "success";
  if (["warning", "warn", "degraded", "slow", "partial"].includes(normalized)) return "warning";
  if (["rate_limited", "429", "throttled"].includes(normalized)) return "rate_limited";
  if (["running", "pending", "in_progress", "applying"].includes(normalized)) return "running";
  if (["failure", "failed", "error", "unavailable", "auth_error", "timeout"].includes(normalized)) return "failure";
  return "unknown";
};

const statusLabel: Record<StatusHistoryState, string> = {
  success: "Successful",
  warning: "Warning",
  failure: "Failed",
  rate_limited: "Rate limited",
  running: "Running",
  unknown: "No data",
};

/** Breaks one check's result into its two distinct sub-signals for the hover tooltip: whether the HTTP call
 *  itself succeeded, and — separately — whether the model actually returned usable prompt content. These can
 *  disagree (HTTP 200 with an empty/refused completion), and collapsing them into one status previously hid that
 *  from anyone reading the bar as "still 200, still fine". `passed` is the check's own final verdict (already
 *  content-validated by verify.ts / the LiteLLM smoke test), so an HTTP-ok-but-not-passed result can only mean the
 *  prompt test itself is what failed. */
export function httpPromptDetail(httpStatus: number | null, passed: boolean, error?: string | null): string {
  const httpOk = typeof httpStatus === "number" && httpStatus >= 200 && httpStatus < 300;
  const httpPart = `HTTP ${httpStatus ?? "—"} - ${httpOk ? "passed" : "failed"}`;
  const promptPart = `Prompt test - ${httpOk ? (passed ? "passed" : "failed") : "not reached"}`;
  return `${httpPart} · ${promptPart}${error ? ` · ${error}` : ""}`;
}

function timestamp(value: StatusHistoryItem["at"]) {
  if (!value) return "Unknown time";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

/**
 * A compact, accessible record of recent checks or runs, rendered as a fixed-width
 * strip of `count` bars. `items` must be newest-first (the convention every query
 * in this codebase already returns). The strip always fills from the right — the
 * most recent observation is the rightmost bar — and left-pads with grey
 * "not run yet" placeholders when there isn't enough history to fill every slot.
 * Hovering (or focusing) a bar shows a small tooltip with its timestamp, status, and detail.
 */
export function StatusHistoryStrip({ items, label = "Recent status history", className = "", count = 14 }: { items: StatusHistoryItem[]; label?: string; className?: string; count?: number }) {
  const recent = items.slice(0, count);
  const padding = Math.max(0, count - recent.length);
  const ordered: Array<StatusHistoryItem | null> = [...Array(padding).fill(null), ...[...recent].reverse()];

  return <span className={`status-history ${className}`} aria-label={label} role="list">
    {ordered.map((item, index) => {
      if (!item) return <span key={`empty-${index}`} className="status-history-item" aria-hidden="true" data-tooltip="Not run yet"><span className="status-history-square status-history-unknown"/></span>;
      const state = stateFor(item.status);
      const text = `${timestamp(item.at)} · ${statusLabel[state]}${item.label ? ` · ${item.label}` : ""}${item.detail ? ` · ${item.detail}` : ""}`;
      const bar = <span className={`status-history-square status-history-${state}`} aria-hidden="true"/>;
      return item.href ? <Link key={`${item.at?.toString() ?? "unknown"}-${index}`} href={item.href} className="status-history-item" aria-label={text} data-tooltip={text} tabIndex={0} role="listitem">{bar}<span className="visually-hidden">{text}</span></Link> : <span key={`${item.at?.toString() ?? "unknown"}-${index}`} className="status-history-item" aria-label={text} data-tooltip={text} tabIndex={0} role="listitem">{bar}<span className="visually-hidden">{text}</span></span>;
    })}
  </span>;
}

/** The same success/unknown classification and recency window UptimeBar renders, exposed standalone so a page can
 *  sort a list by the exact percentage it shows instead of recomputing its own (slightly different) version. */
export function availabilityPercent(items: StatusHistoryItem[], count = 30): number | null {
  const measured = items.slice(0, count).filter(item => { const state = stateFor(item.status); return state !== "unknown" && state !== "running"; });
  if (!measured.length) return null;
  return (measured.filter(item => stateFor(item.status) === "success").length / measured.length) * 100;
}

/** A status strip with a trailing uptime percentage, in the style of a status-page uptime row. `items` must be newest-first. */
export function UptimeBar({ items, label, count = 30, compact = false }: { items: StatusHistoryItem[]; label: string; count?: number; compact?: boolean }) {
  const visible = items.slice(0, count);
  const uptime = availabilityPercent(items, count);
  return <div className="uptime-bar">
    <StatusHistoryStrip items={visible} label={label} count={count} className={compact ? "status-history-compact" : ""}/>
    <span className="uptime-bar-value">{uptime === null ? "No data" : `${uptime.toFixed(uptime === 100 ? 0 : 1)}%`}</span>
  </div>;
}

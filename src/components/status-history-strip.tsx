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
  if (["success", "healthy", "passed", "pass", "completed", "succeeded", "applied", "verified"].includes(normalized)) return "success";
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

function timestamp(value: StatusHistoryItem["at"]) {
  if (!value) return "Unknown time";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

/**
 * A compact, accessible record of recent checks or runs, rendered as a strip of
 * colored bars (green/amber/red/blue/gray). Hovering (or focusing) a bar shows
 * its timestamp, status, and any detail via the native title tooltip.
 */
export function StatusHistoryStrip({ items, label = "Recent status history", className = "", count = 14 }: { items: StatusHistoryItem[]; label?: string; className?: string; count?: number }) {
  const visible = items.slice(0, count);
  if (!visible.length) return <span className={`status-history status-history-empty ${className}`} aria-label={`${label}: no observations`}><span className="status-history-square status-history-unknown" aria-hidden="true"/><span className="status-history-empty-label">No observations</span></span>;

  return <span className={`status-history ${className}`} aria-label={label} role="list">
    {visible.map((item, index) => {
      const state = stateFor(item.status);
      const text = `${timestamp(item.at)} · ${statusLabel[state]}${item.label ? ` · ${item.label}` : ""}${item.detail ? ` · ${item.detail}` : ""}`;
      const bar = <span className={`status-history-square status-history-${state}`} aria-hidden="true"/>;
      return item.href ? <Link key={`${item.at?.toString() ?? "unknown"}-${index}`} href={item.href} className="status-history-item" aria-label={text} title={text} role="listitem">{bar}<span className="visually-hidden">{text}</span></Link> : <span key={`${item.at?.toString() ?? "unknown"}-${index}`} className="status-history-item" aria-label={text} title={text} role="listitem">{bar}<span className="visually-hidden">{text}</span></span>;
    })}
  </span>;
}

/** A status strip with a trailing uptime percentage, in the style of a status-page uptime row. */
export function UptimeBar({ items, label, count = 30 }: { items: StatusHistoryItem[]; label: string; count?: number }) {
  const visible = items.slice(0, count);
  const measured = visible.filter(item => stateFor(item.status) !== "unknown" && stateFor(item.status) !== "running");
  const healthy = measured.filter(item => stateFor(item.status) === "success").length;
  const uptime = measured.length ? (healthy / measured.length) * 100 : null;
  return <div className="uptime-bar">
    <StatusHistoryStrip items={[...visible].reverse()} label={label} count={count}/>
    <span className="uptime-bar-value">{uptime === null ? "No data" : `${uptime.toFixed(uptime === 100 ? 0 : 1)}%`}</span>
  </div>;
}

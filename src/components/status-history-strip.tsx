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
 * A compact, accessible record of recent checks or runs. Pass `href` for an
 * observation when a matching run/detail route exists; otherwise squares stay
 * informational rather than promising unavailable navigation.
 */
export function StatusHistoryStrip({ items, label = "Recent status history", className = "" }: { items: StatusHistoryItem[]; label?: string; className?: string }) {
  const visible = items.slice(0, 14);
  if (!visible.length) return <span className={`status-history status-history-empty ${className}`} aria-label={`${label}: no observations`}><span className="status-history-square status-history-unknown" aria-hidden="true"/><span className="status-history-empty-label">No observations</span></span>;

  return <span className={`status-history ${className}`} aria-label={label} role="list">
    {visible.map((item, index) => {
      const state = stateFor(item.status);
      const text = `${timestamp(item.at)} · ${statusLabel[state]}${item.label ? ` · ${item.label}` : ""}${item.detail ? ` · ${item.detail}` : ""}`;
      const square = <span className={`status-history-square status-history-${state}`} aria-hidden="true"><span className="status-history-glyph">{state === "success" ? "✓" : state === "warning" ? "!" : state === "failure" ? "×" : state === "rate_limited" ? "↯" : state === "running" ? "•" : "–"}</span></span>;
      return item.href ? <Link key={`${item.at?.toString() ?? "unknown"}-${index}`} href={item.href} className="status-history-item" aria-label={text} title={text} role="listitem">{square}<span className="visually-hidden">{text}</span></Link> : <span key={`${item.at?.toString() ?? "unknown"}-${index}`} className="status-history-item" aria-label={text} title={text} role="listitem">{square}<span className="visually-hidden">{text}</span></span>;
    })}
  </span>;
}

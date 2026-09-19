"use client";
import { useState } from "react";

/** An identifier the operator needs to read, compare, and paste elsewhere (a LiteLLM deployment ID, a RatLLM ID).
 *  `compact` shortens it for table cells; the full value is always in the title and is what gets copied. */
export function CopyableId({ value, compact = false, label = "ID" }: { value: string | null | undefined; compact?: boolean; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="settings-help">—</span>;

  async function copy() {
    try { await navigator.clipboard.writeText(value!); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable (insecure context): the value is still selectable */ }
  }
  const shown = compact && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
    <code className="mono" title={value} style={{ overflowWrap: "anywhere", userSelect: "all" }}>{shown}</code>
    <button type="button" className="button small" onClick={copy} aria-label={`Copy ${label}`} style={{ flex: "none" }}>{copied ? "Copied" : "Copy"}</button>
  </span>;
}

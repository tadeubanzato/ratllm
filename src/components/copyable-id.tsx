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
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%" }}>
    <code className="mono" title={value} style={{ overflowWrap: "anywhere", userSelect: "all" }}>{shown}</code>
    <button type="button" onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`} title={copied ? "Copied" : `Copy ${label}`}
      style={{ flex: "none", display: "inline-flex", padding: 2, border: 0, background: "none", cursor: "pointer", color: copied ? "var(--green, currentColor)" : "var(--muted, currentColor)", opacity: copied ? 1 : 0.7 }}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? <path d="M3 8.5l3.2 3.2L13 4.8" /> : <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" /></>}
      </svg>
    </button>
  </span>;
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function SkipProviderButton({providerId, enabled}: {providerId: string; enabled: boolean}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/providers", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({id: providerId, enabled: !enabled})});
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
    } finally { setBusy(false); }
  }

  return <button className="button small" type="button" disabled={busy} onClick={toggle} title={enabled ? "Stop discovery, verification, and health checks from testing this provider" : "Resume testing this provider"}>
    {busy ? "Working…" : enabled ? "Skip" : "Resume"}
  </button>;
}

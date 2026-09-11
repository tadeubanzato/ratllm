"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const label: Record<string, string> = {
  available: "Available", rate_limited: "Rate limited", unavailable: "Unavailable", auth_error: "Auth error",
  credential_missing: "No credential", credential_unverified: "Credential unverified",
  provider_unresolved: "Provider unresolved", provider_not_configured: "No verifier",
};

export function TestCandidateButton({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function run() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/candidates/${candidateId}/verify`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Test failed");
      setMessage(label[body.status] ?? body.status);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Test failed");
    } finally { setBusy(false); }
  }

  return <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
    <button className="button small" type="button" onClick={run} disabled={busy}>{busy ? "Testing…" : "Test"}</button>
    {message && <span style={{ fontSize: 9.5, color: "var(--muted)" }}>{message}</span>}
  </div>;
}

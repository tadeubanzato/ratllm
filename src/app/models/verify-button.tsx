"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck } from "lucide-react";
import { runJobAndWait } from "@/lib/run-job";

export function VerifyButton() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function run() {
    setBusy(true);
    setMessage("Queuing verification…");
    try {
      // Queued for the worker (returns at once); this then follows the real job until it finishes.
      const outcome = await runJobAndWait("CANDIDATE_VERIFICATION", {
        scope: "connected",
        onQueued: info => setMessage(info.workerAlive ? "Queued — the worker starts it within a few seconds…" : "Queued, but no worker is running — it will start as soon as one is."),
        onPhase: phase => setMessage(phase === "running" ? "Calling every connected model…" : "Queued — waiting for the worker…"),
      });
      if (outcome.state === "failed") throw new Error(outcome.message ?? "Verification failed");
      if (outcome.state === "timeout") { setMessage(outcome.message ?? "Still running"); return; }
      const s = outcome.summary ?? {};
      setMessage(`${s.processed ?? 0} tested · ${s.available ?? 0} available, ${s.rateLimited ?? 0} rate-limited, ${s.unavailable ?? 0} down`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Verification failed");
    } finally { setBusy(false); }
  }

  return <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <span style={{ fontSize: 10, color: "var(--muted)" }}>{message}</span>
    <button className="button" type="button" onClick={run} disabled={busy}><BadgeCheck size={14} />{busy ? "Verifying…" : "Run verification"}</button>
  </div>;
}

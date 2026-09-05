"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/components/modal";

export function DeploymentActions({ id, alias, health, live }: { id: string; alias: string; health: string; live: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<"deactivate" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) return;
    const instruction = pending === "delete" ? `DELETE ${alias}` : alias;
    const fields = new FormData(event.currentTarget);
    const confirmation = String(fields.get("confirmation") ?? "");
    const adminToken = String(fields.get("adminToken") ?? "");
    if (confirmation !== instruction) { setError(`Type exactly: ${instruction}`); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/litellm/deployments/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-okame-admin-token": adminToken }, body: JSON.stringify({ action: pending, confirmation }) });
      if (!response.ok) { setError((await response.json().catch(() => null))?.error?.message ?? "LiteLLM change failed"); return; }
      setPending(null);
      router.refresh();
    } finally { setBusy(false); }
  }

  if (!live) return <span>Removed</span>;
  return <>
    <span style={{ display: "inline-flex", gap: 6 }}>
      <button className="button" onClick={() => { setPending("deactivate"); setError(""); }}>Deactivate</button>
      {health !== "HEALTHY" && <button className="button" onClick={() => { setPending("delete"); setError(""); }}>Delete</button>}
    </span>
    <Modal open={pending !== null} title={pending === "delete" ? "Delete deployment" : "Deactivate deployment"} onClose={() => setPending(null)}>
      <form onSubmit={confirm}>
        <p className="settings-help">{pending === "delete" ? "Deletion is permanent in LiteLLM." : "This changes LiteLLM routing."} Type exactly <strong>{pending === "delete" ? `DELETE ${alias}` : alias}</strong> to confirm.</p>
        <label>Confirmation<input className="input" name="confirmation" required autoFocus autoComplete="off"/></label>
        <label>Curator admin token<input className="input" name="adminToken" type="password" required autoComplete="off"/></label>
        {error && <p className="settings-feedback is-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button" onClick={() => setPending(null)}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? "Working…" : pending === "delete" ? "Delete" : "Deactivate"}</button></div>
      </form>
    </Modal>
  </>;
}

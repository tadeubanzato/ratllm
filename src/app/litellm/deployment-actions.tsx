"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/components/modal";
import { confirmationPhrase } from "@/server/litellm/confirmation";

type Action = "deactivate" | "delete" | "adopt";

export interface DeploymentFacts {
  litellmId: string | null;
  providerModelId?: string;
  providerName?: string;
  /** Who manages it in the router (`managed_by`), or null if unrecorded. */
  owner?: string | null;
  managed?: boolean;
}

const TITLE: Record<Action, string> = { deactivate: "Deactivate deployment", delete: "Delete deployment", adopt: "Adopt into RatLLM" };
const BUTTON: Record<Action, string> = { deactivate: "Deactivate", delete: "Delete", adopt: "Adopt" };

export function DeploymentActions({ id, alias, health, live, facts }: { id: string; alias: string; health: string; live: boolean; facts?: DeploymentFacts }) {
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const litellmId = facts?.litellmId ?? null;
  const canAdopt = Boolean(litellmId) && facts?.managed === false;

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || !litellmId) return;
    const instruction = confirmationPhrase(pending, litellmId);
    const confirmation = String(new FormData(event.currentTarget).get("confirmation") ?? "").trim();
    if (confirmation !== instruction) { setError(`Type exactly: ${instruction}`); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/litellm/deployments/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: pending, confirmation }) });
      if (!response.ok) { setError((await response.json().catch(() => null))?.error?.message ?? "LiteLLM change failed"); return; }
      setPending(null);
      router.refresh();
    } finally { setBusy(false); }
  }

  if (!live) return <span>Removed</span>;
  // Without the deployment's own LiteLLM ID there is nothing to confirm against, so offer no change at all.
  if (!litellmId) return <span className="settings-help">No LiteLLM ID</span>;
  const phrase = pending ? confirmationPhrase(pending, litellmId) : "";
  return <>
    <span style={{ display: "inline-flex", gap: 6 }}>
      <button className="button small" onClick={() => { setPending("deactivate"); setError(""); }}>Deactivate</button>
      {/* UNKNOWN means "not tested yet" (e.g. seconds after being added), not "confirmed broken" — offering Delete
          for it invited deleting a deployment before the health monitor ever got a chance to prove it works. */}
      {health !== "HEALTHY" && health !== "UNKNOWN" && <button className="button small" onClick={() => { setPending("delete"); setError(""); }}>Delete</button>}
      {canAdopt && <button className="button small" onClick={() => { setPending("adopt"); setError(""); }}>Adopt</button>}
    </span>
    <Modal open={pending !== null} title={pending ? TITLE[pending] : ""} onClose={() => setPending(null)}>
      <form onSubmit={confirm}>
        <dl className="definition-list" style={{ marginBottom: 12 }}>
          <dt>LiteLLM ID</dt><dd><code className="mono" style={{ overflowWrap: "anywhere" }}>{litellmId}</code></dd>
          <dt>Alias</dt><dd className="mono">{alias}</dd>
          {facts?.providerModelId && <><dt>Model</dt><dd className="mono">{facts.providerModelId}{facts.providerName ? ` · ${facts.providerName}` : ""}</dd></>}
          <dt>Managed by</dt><dd>{facts?.managed ? "RatLLM" : facts?.owner ?? "not recorded"}</dd>
          <dt>Health</dt><dd>{health}</dd>
        </dl>
        {pending === "delete" && <p className="settings-help"><strong>Permanent in LiteLLM.</strong> Only this one deployment is removed; other copies behind the same alias are untouched.</p>}
        {pending === "deactivate" && <p className="settings-help">Blocks this one deployment at the router. It stays listed and can be reactivated.</p>}
        {pending === "adopt" && <div className="settings-help">
          <p><strong>RatLLM will start managing this deployment.</strong> It writes RatLLM as the manager into this deployment&apos;s metadata in LiteLLM, then checks that nothing else in the metadata was lost (and restores it if it was).</p>
          <p>From then on RatLLM health-checks it, and — if auto-remove is switched on — may remove it after repeated failures like any model it manages. If {facts?.owner ?? "the tool that added it"} runs again, it may treat this model differently.</p>
        </div>}
        <p className="settings-help">Type exactly <strong className="mono">{phrase}</strong> to confirm.</p>
        <label>Confirmation<input className="input" name="confirmation" required autoFocus autoComplete="off"/></label>
        {error && <p className="settings-feedback is-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button" onClick={() => setPending(null)}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? "Working…" : pending ? BUTTON[pending] : ""}</button></div>
      </form>
    </Modal>
  </>;
}

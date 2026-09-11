"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function BaseUrlForm({providerId, baseUrl}: {providerId: string; baseUrl: string | null}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("baseUrl") ?? "").trim();
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/settings/providers", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({id: providerId, baseUrl: value})});
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? "Save failed");
      setMessage("Saved.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally { setBusy(false); }
  }

  return <form onSubmit={submit} style={{display: "flex", gap: 8, alignItems: "center"}}>
    <input className="input" name="baseUrl" type="url" defaultValue={baseUrl ?? ""} placeholder="Only needed for account-scoped or self-hosted endpoints" style={{minWidth: 280}}/>
    <button className="button small" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    {message && <small className="settings-help">{message}</small>}
  </form>;
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeploymentActions({ id, alias, health, live }: { id: string; alias: string; health: string; live: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<string | null>(null);
  async function run(action: "deactivate" | "reactivate" | "delete") {
    const instruction = action === "delete" ? `DELETE ${alias}` : alias;
    const confirmation = window.prompt(`${action === "delete" ? "Deletion is permanent in LiteLLM." : "This changes LiteLLM routing."}\nType exactly: ${instruction}`);
    if (confirmation !== instruction) return;
    const adminToken = window.prompt("Enter the Curator admin token to authorize this LiteLLM change");
    if (!adminToken) return;
    setState(action);
    const response = await fetch(`/api/litellm/deployments/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-okame-admin-token": adminToken }, body: JSON.stringify({ action, confirmation }) });
    if (!response.ok) window.alert((await response.json().catch(() => null))?.error?.message ?? "LiteLLM change failed");
    setState(null);
    if (response.ok) router.refresh();
  }
  if (!live) return <span>Removed</span>;
  if (state) return <span>{state === "delete" ? "Deleting…" : "Updating…"}</span>;
  return <span style={{ display: "inline-flex", gap: 6 }}>
    <button className="button" onClick={() => run("deactivate")}>Deactivate</button>
    {health !== "HEALTHY" && <button className="button" onClick={() => run("delete")}>Delete</button>}
  </span>;
}

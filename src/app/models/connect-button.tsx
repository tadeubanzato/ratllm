"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";

type Match = { slug: string; score: number; recommended: boolean; reason: string; alreadyIn: boolean; full: boolean };
type LaneInfo = { blocked: string | null; directAliasName: string | null; members: string[]; matches: Match[]; displayName: string };
type TargetResult = { target: string; lane: string | null; status: string; error?: string };

export function AddToLiteLLMButton({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<LaneInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [directAlias, setDirectAlias] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TargetResult[] | null>(null);
  const [error, setError] = useState("");

  async function openModal() {
    setOpen(true); setResult(null); setError(""); setInfo(null); setDirectAlias(false); setLoading(true);
    try {
      const response = await fetch(`/api/candidates/${candidateId}/lanes`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Could not load lane suggestions");
      setInfo(body as LaneInfo);
      setSelected(new Set((body.matches as Match[]).filter(match => match.recommended && !match.alreadyIn && !match.full).map(match => match.slug)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  function toggle(slug: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  }

  async function submit() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/candidates/${candidateId}/promote`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lanes: [...selected], directAlias }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) throw new Error(body.error?.message ?? "Adding to LiteLLM failed");
      setResult((body.targets ?? []) as TargetResult[]);
      if (body.ok) { router.refresh(); setTimeout(() => setOpen(false), 900); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Adding to LiteLLM failed");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button className="button small" type="button" onClick={openModal}>Add to LiteLLM</button>
    <Modal open={open} title="Add to LiteLLM routing" onClose={() => setOpen(false)}>
      {loading ? <p className="settings-help">Analysing capabilities…</p>
        : error && !info ? <p className="settings-feedback is-error">{error}</p>
          : info?.blocked ? <p className="settings-feedback is-error">{info.blocked}</p>
            : info ? <div style={{ display: "grid", gap: 12 }}>
              <p className="settings-help">Pre-checked lanes are auto-selected from the model’s capabilities. Adding it to a lane puts it in that group’s routing pool and its fallback chain.</p>
              <div style={{ display: "grid", gap: 10 }}>
                {info.matches.map(match => {
                  const laneResults = result?.filter(item => item.lane === match.slug) ?? [];
                  return <label key={match.slug} style={{ display: "flex", gap: 8, alignItems: "flex-start", opacity: match.alreadyIn || match.full ? 0.55 : 1 }}>
                    <input type="checkbox" checked={match.alreadyIn || selected.has(match.slug)} disabled={match.alreadyIn || match.full || busy} onChange={() => toggle(match.slug)} />
                    <span style={{ display: "grid", gap: 2 }}>
                      <span style={{ fontWeight: 600 }}>{match.slug}{match.alreadyIn ? " · already added" : match.full ? " · lane full" : match.recommended ? "" : " · optional"}</span>
                      <span className="settings-help">{match.reason}</span>
                      {laneResults.map((item, index) => <span key={index} className="settings-help" style={{ color: item.status === "failed" ? "var(--red)" : "var(--green)" }}>
                        {item.status === "failed" ? `Failed: ${item.error}` : item.status === "exists" ? "Already present" : "Added ✓"}
                      </span>)}
                    </span>
                  </label>;
                })}
              </div>
              {info.directAliasName && <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={directAlias} disabled={busy} onChange={() => setDirectAlias(value => !value)} />
                <span style={{ display: "grid", gap: 2 }}>
                  <span style={{ fontWeight: 600 }}>Direct alias</span>
                  <span className="settings-help mono">{info.directAliasName}</span>
                </span>
              </label>}
              {error && <p className="settings-feedback is-error">{error}</p>}
              <div className="modal-actions">
                <button className="button" type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
                <button className="button primary" type="button" onClick={submit} disabled={busy || (selected.size === 0 && !directAlias)}>{busy ? "Adding…" : "Add"}</button>
              </div>
            </div> : null}
    </Modal>
  </>;
}

"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface DetectCandidateResult { url: string; outcome: "hit" | "miss"; status: number | null; detail: string }
interface DetectResult { candidates: DetectCandidateResult[]; suggestion: string | null }
interface CloudflareAccountResult { accounts: {id: string; name: string}[]; suggestion: string | null; error: string | null }

export function BaseUrlForm({providerId, slug, baseUrl}: {providerId: string; slug: string; baseUrl: string | null}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null);
  const [detectError, setDetectError] = useState("");
  const [cfResult, setCfResult] = useState<CloudflareAccountResult | null>(null);
  const [cfBusy, setCfBusy] = useState(false);

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

  async function autoDetect() {
    setDetecting(true); setDetectError(""); setDetectResult(null);
    try {
      const response = await fetch(`/api/providers/${providerId}/auto-detect`, {method: "POST"});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Auto-detect failed");
      setDetectResult(body);
    } catch (error) {
      setDetectError(error instanceof Error ? error.message : "Auto-detect failed");
    } finally { setDetecting(false); }
  }

  async function findCloudflareAccount() {
    setCfBusy(true); setCfResult(null);
    try {
      const response = await fetch(`/api/providers/${providerId}/cloudflare-account`, {method: "POST"});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Lookup failed");
      setCfResult(body);
    } catch (error) {
      setCfResult({accounts: [], suggestion: null, error: error instanceof Error ? error.message : "Lookup failed"});
    } finally { setCfBusy(false); }
  }

  function fillBaseUrl(url: string) {
    if (inputRef.current) inputRef.current.value = url;
  }

  const isCloudflare = slug === "cloudflare-workers-ai";

  return <div style={{display: "grid", gap: 8}}>
    <form onSubmit={submit} style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
      <input ref={inputRef} className="input" name="baseUrl" type="url" defaultValue={baseUrl ?? ""} placeholder="Only needed for account-scoped or self-hosted endpoints" style={{minWidth: 280}}/>
      <button className="button small" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      {isCloudflare
        ? <button className="button small" type="button" disabled={cfBusy} onClick={() => void findCloudflareAccount()}>{cfBusy ? "Looking up…" : "Find my Cloudflare account"}</button>
        : <button className="button small" type="button" disabled={detecting} onClick={() => void autoDetect()}>{detecting ? "Detecting…" : "Auto-detect"}</button>}
      {message && <small className="settings-help">{message}</small>}
    </form>

    {cfResult && <div className="settings-help" style={{display: "grid", gap: 4}}>
      {cfResult.error && <span>Couldn&rsquo;t look this up automatically: {cfResult.error}. Find your Account ID on the right side of any page in the <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">Cloudflare dashboard</a>, then enter <code>https://api.cloudflare.com/client/v4/accounts/&lt;account-id&gt;/ai</code> above.</span>}
      {cfResult.suggestion && <div style={{display: "flex", gap: 8, alignItems: "center"}}><span>Found one account — <strong>{cfResult.accounts[0].name}</strong>: <strong className="mono">{cfResult.suggestion}</strong></span><button className="button small" type="button" onClick={() => fillBaseUrl(cfResult.suggestion!)}>Use this</button></div>}
      {!cfResult.suggestion && !cfResult.error && cfResult.accounts.length > 1 && <div style={{display: "grid", gap: 4}}>
        <span>Your token has access to {cfResult.accounts.length} accounts — pick the one this credential should route through:</span>
        {cfResult.accounts.map(account => <div key={account.id} style={{display: "flex", gap: 8, alignItems: "center"}}><span className="mono" style={{fontSize: 9.5}}>{account.name} · {account.id}</span><button className="button small" type="button" onClick={() => fillBaseUrl(`https://api.cloudflare.com/client/v4/accounts/${account.id}/ai`)}>Use this</button></div>)}
      </div>}
      {!cfResult.suggestion && !cfResult.error && cfResult.accounts.length === 0 && <span>This token has no accessible accounts — check it&rsquo;s actually a Cloudflare API Token (not a Global API Key) with Account access.</span>}
    </div>}

    {detectError && <p className="settings-feedback is-error" role="alert">{detectError}</p>}
    {detectResult && <div className="settings-help" style={{display: "grid", gap: 4}}>
      <span>Tried {detectResult.candidates.length} likely URL{detectResult.candidates.length === 1 ? "" : "s"} with your saved credential — a live, best-effort guess, not a guarantee. A hit just means the request landed on a real completions-shaped API, not necessarily that a model call would succeed.</span>
      {detectResult.candidates.map(candidate => <span key={candidate.url} className="mono" style={{fontSize: 9.5, color: candidate.outcome === "hit" ? "var(--green)" : "var(--faint)"}}>{candidate.outcome === "hit" ? "✓" : "·"} {candidate.url} — {candidate.detail}</span>)}
      {detectResult.suggestion
        ? <div style={{display: "flex", gap: 8, alignItems: "center", marginTop: 2}}><span>Best guess: <strong className="mono">{detectResult.suggestion}</strong></span><button className="button small" type="button" onClick={() => fillBaseUrl(detectResult.suggestion!)}>Use this</button></div>
        : <span>No single clear match — {detectResult.candidates.some(c => c.outcome === "hit") ? "more than one candidate looked plausible" : "none of the guessed URLs look right"}. This provider likely needs a Base URL researched from its own docs.</span>}
    </div>}
  </div>;
}

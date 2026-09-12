"use client";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/status-pill";
import { MASKED_SECRET_PLACEHOLDER } from "@/lib/utils";
export async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, {...init, headers: {"content-type": "application/json", ...init?.headers}});
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : "Request failed. Please try again."));
  return body;
}
type Summary = {baseUrl: string; configured: boolean; status: string; lastSuccess: string | null; lastTestAt: string | null; error: string | null; deploymentCount: number | null};
const url = "/api/settings/litellm";
export function LiteLLMConnectionForm() {
  const [data, setData] = useState<Summary | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let active = true; request(url).then(value => {if(active)setData(value)}).catch(error => {if(active){setMessage(error.message);setFailed(true)}}); return () => {active = false}; }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
    const test = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "test";
    setBusy(true); setFailed(false); setMessage(test ? "Saving and testing connection…" : "Saving…");
    try {
      const secret = String(fields.get("secret") ?? "");
      await request(url, {method: "PUT", body: JSON.stringify({baseUrl: fields.get("baseUrl"), ...(secret ? {masterKey: secret} : {})})});
      (form.elements.namedItem("secret") as HTMLInputElement).value = "";
      if (test) await request(url, {method: "POST"});
      setMessage(test ? "LiteLLM connection successful." : "Settings saved. Test the connection to verify them.");
    } catch(error) {setFailed(true); setMessage(error instanceof Error ? error.message : "Request failed");}
    finally {try {setData(await request(url))} catch {} setBusy(false);}
  }
  return <section className="panel settings-card"><div className="panel-header"><h3>LiteLLM connection</h3>{data && <StatusPill value={data.status}/>}</div><div className="panel-body">
    {!data ? <p role="status">{message || "Loading connection settings…"}</p> : <form onSubmit={submit} className="settings-form">
      <label>Base URL<input className="input" name="baseUrl" type="url" required defaultValue={data.baseUrl} placeholder="http://litellm:4000"/></label>
      <label>Master key<input className="input" name="secret" type="password" minLength={8} autoComplete="new-password" placeholder={data.configured ? MASKED_SECRET_PLACEHOLDER : "Enter credential"}/><small>Encrypted on the server. Stored credentials are never returned{data.configured ? " — leave this field blank to keep the current one" : ""}.</small></label>
      <div className="settings-actions"><button className="button primary" disabled={busy} type="submit" value="save">Save settings</button><button className="button" disabled={busy} type="submit" value="test">{busy ? "Working…" : "Test connection"}</button></div>
      <dl className="definition-list"><dt>Credential</dt><dd>{data.configured ? "Configured" : "Missing"}</dd><dt>Last successful connection</dt><dd>{data.lastSuccess ? new Date(data.lastSuccess).toLocaleString() : "No successful test recorded"}</dd><dt>Last test</dt><dd>{data.lastTestAt ? new Date(data.lastTestAt).toLocaleString() : "Not tested"}</dd><dt>Available deployments</dt><dd>{data.deploymentCount ?? "Not retrieved"}</dd></dl>
      {(message || data.error) && <p className={`settings-feedback ${failed || data.error ? "is-error" : ""}`} role={failed ? "alert" : "status"}>{message || data.error}</p>}
    </form>}
  </div></section>;
}

type ManagementSettings = {autoAdd: boolean; autoRemove: boolean};
const managementUrl = "/api/settings/litellm/management";

export function LiteLLMManagementForm() {
  const [data, setData] = useState<ManagementSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { let active = true; request(managementUrl).then(value => {if(active)setData(value)}).catch(error => {if(active)setMessage(error.message)}); return () => {active = false}; }, []);

  async function toggle(key: keyof ManagementSettings, checked: boolean) {
    setBusy(true); setMessage("");
    try { setData(await request(managementUrl, {method: "PATCH", body: JSON.stringify({[key]: checked})})); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  }

  return <section className="panel settings-card"><div className="panel-header"><h3>LiteLLM auto pilot mode</h3></div><div className="panel-body">
    <p className="settings-help">Let ratllm keep LiteLLM&rsquo;s routing pool clean on its own, instead of adding or removing models by hand.</p>
    {!data ? <p role="status">{message || "Loading…"}</p> : <div style={{display: "grid", gap: 16, marginTop: 14}}>
      <label style={{display: "flex", gap: 10, alignItems: "flex-start"}}>
        <input type="checkbox" aria-label="Auto-add candidates to LiteLLM" checked={data.autoAdd} disabled={busy} onChange={event => void toggle("autoAdd", event.target.checked)}/>
        <span style={{display: "grid", gap: 2}}><strong style={{fontSize: 12.5}}>Auto-add</strong><span className="settings-help">Adds a discovered candidate to its recommended lanes once it has passed 5 availability checks in a row, skipping any lane already at its member cap.</span></span>
      </label>
      <label style={{display: "flex", gap: 10, alignItems: "flex-start"}}>
        <input type="checkbox" aria-label="Auto-remove failing deployments from LiteLLM" checked={data.autoRemove} disabled={busy} onChange={event => void toggle("autoRemove", event.target.checked)}/>
        <span style={{display: "grid", gap: 2}}><strong style={{fontSize: 12.5}}>Auto-remove</strong><span className="settings-help">Removes a managed deployment from LiteLLM after 5 consecutive failed health checks (timeouts, 404/410, and other errors — a 429 rate limit never counts against it) and quarantines the model.</span></span>
      </label>
      {message && <p className="settings-feedback is-error" role="alert">{message}</p>}
    </div>}
  </div></section>;
}

export interface LaneOverviewItem { slug: string; purpose: string; fallback: string[] }

const autoSetupUrl = "/api/litellm/auto-setup";

export function LiteLLMLaneSetupPanel({lanes}: {lanes: LaneOverviewItem[]}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function runAutoSetup() {
    setBusy(true); setFailed(false); setMessage("Pushing lane and fallback configuration to LiteLLM…");
    try {
      const result = await request(autoSetupUrl, {method: "POST"});
      const repaired = result.repaired?.length ?? 0;
      setMessage(repaired ? `Done. Repaired ${repaired} lane membership${repaired === 1 ? "" : "s"} and refreshed the fallback chains.` : "Done. Fallback chains are pushed and every lane member is in sync.");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Auto setup failed");
    } finally { setBusy(false); }
  }

  return <section className="panel settings-card"><div className="panel-header"><h3>Lanes &amp; fallback strategy</h3></div><div className="panel-body">
    <p className="settings-help">Every model added to LiteLLM joins one of these <code>smart-*</code> routing lanes. If a lane runs out of healthy deployments, LiteLLM automatically falls back to the lanes listed below it — so a request never fails just because one lane is empty.</p>
    <div className="settings-table-wrap" style={{marginTop: 12}}>
      <table className="data-table settings-table">
        <thead><tr><th>Lane</th><th>Purpose</th><th>Falls back to</th></tr></thead>
        <tbody>{lanes.map(lane => <tr key={lane.slug}>
          <td className="mono">{lane.slug}</td>
          <td>{lane.purpose}</td>
          <td>{lane.fallback.length ? lane.fallback.map(f => f.replace("smart-", "")).join(" → ") : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="settings-help" style={{marginTop: 14}}>
      <strong>Auto setup</strong> pushes this exact lane and fallback strategy to LiteLLM right now, and re-adds any lane member whose deployment went missing from LiteLLM. It never removes anything, and it needs the LiteLLM master key configured above first.
    </p>
    <div className="settings-actions" style={{marginTop: 8}}>
      <button className="button primary" type="button" disabled={busy} onClick={() => void runAutoSetup()}>{busy ? "Setting up…" : "Auto setup LiteLLM"}</button>
    </div>
    {message && <p className={`settings-feedback ${failed ? "is-error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
  </div></section>;
}

"use client";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/status-pill";
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
      <label>Master key<input className="input" name="secret" type="password" minLength={8} autoComplete="new-password" placeholder={data.configured ? "Configured · leave blank to keep" : "Enter credential"}/><small>Encrypted on the server. Stored credentials are never returned.</small></label>
      <div className="settings-actions"><button className="button primary" disabled={busy} type="submit" value="save">Save settings</button><button className="button" disabled={busy} type="submit" value="test">{busy ? "Working…" : "Test connection"}</button></div>
      <dl className="definition-list"><dt>Credential</dt><dd>{data.configured ? "Configured" : "Missing"}</dd><dt>Last successful connection</dt><dd>{data.lastSuccess ? new Date(data.lastSuccess).toLocaleString() : "No successful test recorded"}</dd><dt>Last test</dt><dd>{data.lastTestAt ? new Date(data.lastTestAt).toLocaleString() : "Not tested"}</dd><dt>Available deployments</dt><dd>{data.deploymentCount ?? "Not retrieved"}</dd></dl>
      {(message || data.error) && <p className={`settings-feedback ${failed || data.error ? "is-error" : ""}`} role={failed ? "alert" : "status"}>{message || data.error}</p>}
    </form>}
  </div></section>;
}

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { StatusHistoryStrip, type StatusHistoryItem } from "@/components/status-history-strip";
import { LiteLLMConnectionForm, request } from "./connection-form";
import { CredentialForm } from "@/app/providers/[id]/credential-form";
import { StatusPill } from "@/components/status-pill";
import { Modal } from "@/components/modal";
import { cronToSchedule, scheduleToCron, scheduleUnits, type ScheduleUnit } from "@/lib/schedule";

const tabs = ["General", "LiteLLM", "Providers", "Automation", "Model Sources", "API Access", "Safety"] as const;
type Tab = (typeof tabs)[number];
type Provider = {id: string; name: string; slug: string; enabled: boolean; credentialState: string; lastValidatedAt: string | null; environmentVariable: string; testSupported: boolean; portal: {url: string; label: string} | null};
type Job = {type: string; enabled: boolean; schedule: string; timezone: string; status: string; lastRunAt: string | null; nextRunAt: string | null; durationMs: number | null; failureCount: number; lastError: string | null};
type Source = {id: string; name: string; type: string; providerId: string | null; url: string | null; enabled: boolean; priority: number; status: string; discoveredModelCount: number; lastSyncAt: string | null};
type ApiKey = {id: string; name: string; prefix: string; scopes: string[]; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null};
type Lane = {slug: string; minimumHealthy: number};

const stamp = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "—";

function Card({title, children, aside}: {title: string; children: React.ReactNode; aside?: React.ReactNode}) {
  return <section className="panel settings-card"><div className="panel-header"><h3>{title}</h3>{aside}</div><div className="panel-body">{children}</div></section>;
}
function History({items, label}: {items: StatusHistoryItem[]; label: string}) {
  return <div className="history-row"><StatusHistoryStrip label={label} items={items.slice(0, 14)}/></div>;
}

function ScheduleEditor({schedule, jobType, disabled, onSave}: {schedule: string; jobType: string; disabled: boolean; onSave: (cron: string) => void}) {
  const parsed = cronToSchedule(schedule);
  const [custom, setCustom] = useState(parsed === null);
  const [n, setN] = useState(parsed?.n ?? 1);
  const [unit, setUnit] = useState<ScheduleUnit>(parsed?.unit ?? "DAY");
  const [trackedSchedule, setTrackedSchedule] = useState(schedule);

  if (schedule !== trackedSchedule) {
    setTrackedSchedule(schedule);
    setCustom(parsed === null);
    if (parsed) { setN(parsed.n); setUnit(parsed.unit); }
  }

  if (custom) return <div className="schedule-picker">
    <input aria-label={`${jobType} cron schedule`} className="input compact-input" defaultValue={schedule} disabled={disabled} onBlur={event => onSave(event.target.value)}/>
    <button type="button" className="button" disabled={disabled} onClick={() => { setCustom(false); setN(1); setUnit("DAY"); onSave(scheduleToCron(1, "DAY")); }}>Use simple schedule</button>
  </div>;

  return <div className="schedule-picker">
    <span>Every</span>
    <select aria-label={`${jobType} interval count`} className="input compact-input" disabled={disabled} value={n} onChange={event => { const next = Number(event.target.value); setN(next); onSave(scheduleToCron(next, unit)); }}>
      {Array.from({length: 10}, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}
    </select>
    <select aria-label={`${jobType} interval unit`} className="input compact-input" disabled={disabled} value={unit} onChange={event => { const next = event.target.value as ScheduleUnit; setUnit(next); onSave(scheduleToCron(n, next)); }}>
      {scheduleUnits.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
    <button type="button" className="button" disabled={disabled} onClick={() => setCustom(true)}>Custom cron</button>
  </div>;
}

export function SettingsClient({environment, lanes, initialHistory, smokeHistory}: {environment: string; lanes: Lane[]; initialHistory: StatusHistoryItem[]; smokeHistory: StatusHistoryItem[]}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as Tab | null;
  const [active, setActive] = useState<Tab>(tabParam && tabs.includes(tabParam) ? tabParam : "General");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [sourceModal, setSourceModal] = useState<null | {mode: "add"} | {mode: "edit"; source: Source}>(null);
  const [keyModal, setKeyModal] = useState(false);
  const [addProviderModal, setAddProviderModal] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [jobHistory, setJobHistory] = useState<StatusHistoryItem[]>(initialHistory);

  function changeTab(tab: Tab) {
    setActive(tab); setMessage("");
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`?${params.toString()}`, {scroll: false});
  }

  async function runJobNow(type: string) {
    setBusy(true); setMessage("");
    try {
      const result = await request("/api/settings/automation/run", {method: "POST", body: JSON.stringify({type})});
      if (result.started) {
        setJobHistory(current => [{at: new Date().toISOString(), status: "SUCCEEDED", label: type}, ...current]);
        setMessage("Saved.");
      } else {
        setMessage(result.reason === "already_running" ? "That job is already running." : "Saved.");
      }
      setJobs(await request("/api/settings/automation"));
    } catch (error) {
      setJobHistory(current => [{at: new Date().toISOString(), status: "FAILED", label: type, detail: error instanceof Error ? error.message : undefined}, ...current]);
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally { setBusy(false); }
  }

  useEffect(() => {
    const endpoint = active === "Providers" ? "/api/settings/providers" : active === "Automation" ? "/api/settings/automation" : active === "Model Sources" ? "/api/settings/model-sources" : active === "API Access" ? "/api/settings/api-keys" : null;
    if (!endpoint) return;
    let current = true;
    const timer = setTimeout(() => {
      setLoading(true); setMessage("");
      request(endpoint).then(value => {
        if (!current) return;
        if (active === "Providers") setProviders(value);
        else if (active === "Automation") setJobs(value);
        else if (active === "Model Sources") setSources(value);
        else setKeys(value);
      }).catch(error => { if (current) setMessage(error.message); }).finally(() => { if (current) setLoading(false); });
    }, 0);
    return () => { current = false; clearTimeout(timer); };
  }, [active]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setMessage("");
    try {
      await fn(); setMessage("Saved.");
      if (active === "Providers") setProviders(await request("/api/settings/providers"));
      if (active === "Automation") setJobs(await request("/api/settings/automation"));
      if (active === "Model Sources") setSources(await request("/api/settings/model-sources"));
      if (active === "API Access") setKeys(await request("/api/settings/api-keys"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  }

  const sourceHistory = (source: Source) => source.lastSyncAt ? [{at: source.lastSyncAt, status: source.status, label: source.name, detail: `${source.discoveredModelCount} discovered models`}] : [];

  return <div className="settings-control-center">
    <nav className="settings-tabs" aria-label="Settings sections">{tabs.map(tab => <button type="button" key={tab} aria-current={active === tab ? "page" : undefined} className={active === tab ? "active" : ""} onClick={() => changeTab(tab)}>{tab}</button>)}</nav>
    <p className="settings-feedback" role="status" style={loading || message ? undefined : {visibility: "hidden"}}>{loading ? "Loading settings…" : message || " "}</p>

    {active === "General" && <div className="settings-grid">
      <Card title="Control plane status"><dl className="definition-list">
        <dt>Database scheduler</dt><dd>Worker-owned · self-hosted, no external orchestrator required</dd>
        <dt>Recent automation</dt><dd><History label="Recent automation history" items={jobHistory}/></dd>
        <dt>System health</dt><dd><History label="Recent health observations" items={smokeHistory}/></dd>
      </dl></Card>
      <Card title="Operating profile"><dl className="definition-list">
        <dt>Application</dt><dd>Okame Model Curator</dd>
        <dt>Environment</dt><dd>{environment}</dd>
        <dt>Credential storage</dt><dd>Server environment variables or encrypted server-side secrets. Saving a replacement never displays the stored secret.</dd>
      </dl></Card>
    </div>}

    {active === "LiteLLM" && <LiteLLMConnectionForm/>}

    {active === "Providers" && <Card title="Provider credentials" aside={<button className="button primary" type="button" onClick={() => setAddProviderModal(true)}>Add provider</button>}><div className="settings-table-wrap"><table className="data-table settings-table"><thead><tr><th>Provider</th><th>Enabled</th><th>Credential</th><th>Last credential test</th><th>Actions</th></tr></thead><tbody>
      {providers.map(provider => <tr key={provider.id}>
        <td><strong>{provider.name}</strong></td>
        <td><input type="checkbox" aria-label={`Enable ${provider.name}`} checked={provider.enabled} disabled={busy} onChange={event => void act(() => request("/api/settings/providers", {method: "PATCH", body: JSON.stringify({id: provider.id, enabled: event.target.checked})}))}/></td>
        <td><StatusPill value={provider.credentialState}/></td>
        <td>{stamp(provider.lastValidatedAt)}</td>
        <td><div className="settings-actions">
          <button className="button" type="button" onClick={() => setEditing(editing === provider.id ? null : provider.id)}>Configure credential</button>
          {provider.testSupported ? <button className="button" type="button" disabled={busy || !provider.enabled || provider.credentialState === "MISSING"} onClick={() => void act(async () => { await request(`/api/providers/${provider.id}/verify`, {method: "POST"}); })}>Test credential</button> : <span className="settings-help">API test unavailable</span>}
        </div></td>
      </tr>)}
    </tbody></table></div>
    </Card>}
    <Modal open={editing !== null} title={`${providers.find(p => p.id === editing)?.name ?? ""} credential`} onClose={() => setEditing(null)}>
      {editing && providers.find(p => p.id === editing)?.portal && <p className="settings-help"><a href={providers.find(p => p.id === editing)!.portal!.url} target="_blank" rel="noopener noreferrer">{providers.find(p => p.id === editing)!.portal!.label} on {providers.find(p => p.id === editing)?.name} ↗</a></p>}
      {editing && <CredentialForm providerId={editing} defaultEnv={providers.find(p => p.id === editing)!.environmentVariable}/>}
    </Modal>

    {active === "Automation" && <Card title="Automation jobs" aside={<span>Database-backed scheduler</span>}>
      <p className="settings-help">Each job is claimed with a lease before execution, preventing overlap across worker restarts. Changes take effect when the worker next checks for due jobs.</p>
      <div className="automation-jobs">
        {jobs.map(job => <div className="automation-job-card" key={job.type}>
          <div className="automation-job-header">
            <div className="automation-job-name">
              <input aria-label={`${job.type} enabled`} type="checkbox" checked={job.enabled} disabled={busy} onChange={event => void act(() => request(`/api/settings/automation?type=${job.type}`, {method: "PATCH", body: JSON.stringify({enabled: event.target.checked})}))}/>
              <strong>{job.type.replaceAll("_", " ")}</strong>
              <StatusPill value={job.status}/>
            </div>
            <div className="settings-actions">
              <button className="button" type="button" disabled={busy} onClick={() => void runJobNow(job.type)}>Run now</button>
              <Link className="button" href={`/runs?type=${job.type}`}>View runs</Link>
            </div>
          </div>
          <div className="automation-job-body">
            <div>
              <label className="settings-job-label">Schedule</label>
              <ScheduleEditor schedule={job.schedule} jobType={job.type} disabled={busy} onSave={cron => void act(() => request(`/api/settings/automation?type=${job.type}`, {method: "PATCH", body: JSON.stringify({schedule: cron})}))}/>
            </div>
            <div className="automation-job-stats">
              <div><small>Next run</small><strong>{stamp(job.nextRunAt)}</strong></div>
              <div><small>Last run</small><strong>{stamp(job.lastRunAt)}</strong></div>
              <div><small>Duration</small><strong>{job.durationMs ?? "—"} ms</strong></div>
              <div><small>Failures</small><strong>{job.failureCount}</strong></div>
            </div>
          </div>
          {job.lastError && <p className="settings-feedback is-error">{job.lastError}</p>}
          <div className="automation-job-history">
            <small>Recent runs</small>
            <StatusHistoryStrip label={`${job.type} execution history`} items={jobHistory.filter(item => item.label === job.type)}/>
          </div>
        </div>)}
      </div>
    </Card>}

    {active === "Model Sources" && <Card title="Model source management" aside={<button className="button primary" type="button" onClick={() => setSourceModal({mode: "add"})}>Add source</button>}>
      <p className="settings-help">Manual sources can be used for a manually entered model inventory; external feeds are tested before sync.</p>
      <div className="settings-table-wrap"><table className="data-table settings-table"><thead><tr><th>Source / provider</th><th>Type</th><th>Enabled</th><th>Status</th><th>Last sync / models</th><th>History</th><th>Actions</th></tr></thead><tbody>
        {sources.map(source => <tr key={source.id}>
          <td><strong>{source.name}</strong><br/><small>{source.url ?? "Manual source"}</small></td>
          <td>{source.type.replaceAll("_", " ")}</td>
          <td><input aria-label={`${source.name} enabled`} type="checkbox" checked={source.enabled} disabled={busy} onChange={event => void act(() => request("/api/settings/model-sources", {method: "POST", body: JSON.stringify({...source, enabled: event.target.checked})}))}/></td>
          <td>{source.status}</td>
          <td>{stamp(source.lastSyncAt)}<br/>{source.discoveredModelCount} models</td>
          <td><StatusHistoryStrip label={`${source.name} sync history`} items={sourceHistory(source)}/></td>
          <td>
            <button className="button" type="button" disabled={busy} onClick={() => void act(() => request("/api/settings/model-sources/action", {method: "POST", body: JSON.stringify({sourceId: source.id, action: "sync"})}))}>Test / sync now</button>{" "}
            <button className="button" type="button" disabled={busy} onClick={() => setSourceModal({mode: "edit", source})}>Edit</button>{" "}
            <button className="button" type="button" disabled={busy} onClick={() => void act(() => request(`/api/settings/model-sources?id=${source.id}`, {method: "DELETE"}))}>Delete</button>
          </td>
        </tr>)}
      </tbody></table></div>
      <div className="manual-model-form"><strong>Manual model entry</strong><input className="input" placeholder="provider/model-id"/><button className="button" type="button" onClick={() => setMessage("Manual model entry is stored through the selected Manual source during discovery")}>Add manual model</button></div>
    </Card>}

    {active === "API Access" && <Card title="RATLLM API keys" aside={<button className="button primary" type="button" onClick={() => setKeyModal(true)}>Generate key</button>}>
      <div className="settings-table-wrap"><table className="data-table settings-table"><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Created / expires</th><th>Last used</th><th>State</th><th>Actions</th></tr></thead><tbody>
        {keys.map(key => <tr key={key.id}>
          <td>{key.name}</td><td className="mono">{key.prefix}</td><td>{key.scopes.join(", ")}</td>
          <td>{stamp(key.createdAt)}<br/>{stamp(key.expiresAt)}</td><td>{stamp(key.lastUsedAt)}</td>
          <td>{key.revokedAt ? "Revoked" : "Active"}</td>
          <td>
            <button className="button" type="button" disabled={busy} onClick={() => void act(() => request("/api/settings/api-keys", {method: "PATCH", body: JSON.stringify({keyId: key.id, action: "rotate", graceHours: 1})}))}>Rotate</button>{" "}
            <button className="button" type="button" disabled={busy} onClick={() => void act(() => request("/api/settings/api-keys", {method: "PATCH", body: JSON.stringify({keyId: key.id, action: "revoke"})}))}>Revoke</button>
          </td>
        </tr>)}
      </tbody></table></div>
    </Card>}

    {active === "Safety" && <div className="settings-grid">
      <Card title="Current safety policy"><dl className="definition-list">
        <dt>Rate limit safety factor</dt><dd>70% · current worker policy</dd>
        <dt>Maximum changes per run</dt><dd>No enforced setting in this implementation</dd>
        <dt>Maximum removals per run</dt><dd>No enforced setting in this implementation</dd>
        <dt>Auto-apply safe changes</dt><dd>No implemented policy toggle</dd>
      </dl><p className="settings-help">These policies are shown read-only because editable controls require enforcement in the worker.</p></Card>
      <Card title="Minimum healthy models per lane"><dl className="definition-list">
        {lanes.map(lane => <div className="settings-definition-row" key={lane.slug}><dt>{lane.slug}</dt><dd>{lane.minimumHealthy}</dd></div>)}
      </dl></Card>
    </div>}

    <Modal open={sourceModal !== null} title={sourceModal?.mode === "edit" ? "Rename source" : "Add model source"} onClose={() => setSourceModal(null)}>
      <form onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const name = String(fields.get("name") ?? "").trim();
        if (!name) return;
        if (sourceModal?.mode === "edit") {
          void act(() => request("/api/settings/model-sources", {method: "POST", body: JSON.stringify({...sourceModal.source, name})}));
        } else {
          const url = String(fields.get("url") ?? "").trim();
          void act(() => request("/api/settings/model-sources", {method: "POST", body: JSON.stringify({name, type: url ? "JSON_FEED" : "MANUAL", url: url || null, enabled: true, priority: 100})}));
        }
        setSourceModal(null);
      }}>
        <label>Source name<input className="input" name="name" required autoFocus defaultValue={sourceModal?.mode === "edit" ? sourceModal.source.name : ""}/></label>
        {sourceModal?.mode === "add" && <label>Source URL<input className="input" name="url" type="url" placeholder="Leave blank for a Manual source"/></label>}
        <div className="modal-actions"><button type="button" className="button" onClick={() => setSourceModal(null)}>Cancel</button><button type="submit" className="button primary">{sourceModal?.mode === "edit" ? "Save" : "Add source"}</button></div>
      </form>
    </Modal>

    <Modal open={keyModal} title="Generate API key" onClose={() => setKeyModal(false)}>
      <form onSubmit={event => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
        if (!name) return;
        setKeyModal(false);
        void act(async () => { const result = await request("/api/settings/api-keys", {method: "POST", body: JSON.stringify({name, scopes: ["read", "automation"]})}); setRevealedKey(result.key); return result; });
      }}>
        <label>Key name<input className="input" name="name" required autoFocus placeholder="e.g. external monitoring integration"/></label>
        <div className="modal-actions"><button type="button" className="button" onClick={() => setKeyModal(false)}>Cancel</button><button type="submit" className="button primary">Generate</button></div>
      </form>
    </Modal>

    <Modal open={revealedKey !== null} title="API key created" onClose={() => setRevealedKey(null)}>
      <p className="settings-help">Copy this key now — it will not be shown again.</p>
      <p className="modal-secret">{revealedKey}</p>
      <div className="modal-actions"><button type="button" className="button primary" onClick={() => setRevealedKey(null)}>Done</button></div>
    </Modal>

    <Modal open={addProviderModal} title="Add provider" onClose={() => setAddProviderModal(false)}>
      <form onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const name = String(fields.get("name") ?? "").trim();
        const baseUrl = String(fields.get("baseUrl") ?? "").trim();
        const apiKey = String(fields.get("apiKey") ?? "").trim();
        if (!name) return;
        setAddProviderModal(false);
        void act(() => request("/api/settings/providers", {method: "POST", body: JSON.stringify({name, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined})}));
      }}>
        <label>Provider name<input className="input" name="name" required autoFocus placeholder="e.g. My Local vLLM"/></label>
        <label>API URL<input className="input" name="baseUrl" type="url" placeholder="https://api.example.com/v1 (optional)"/></label>
        <label>API key<input className="input" name="apiKey" type="password" minLength={8} autoComplete="new-password" placeholder="Stored encrypted"/></label>
        <div className="modal-actions"><button type="button" className="button" onClick={() => setAddProviderModal(false)}>Cancel</button><button type="submit" className="button primary">Add provider</button></div>
      </form>
    </Modal>
  </div>;
}

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { StatusHistoryStrip, type StatusHistoryItem } from "@/components/status-history-strip";
import { LiteLLMConnectionForm, LiteLLMManagementForm, LiteLLMLaneSetupPanel, type LaneOverviewItem, request } from "./connection-form";
import { CredentialForm } from "@/app/providers/[id]/credential-form";
import { StatusPill } from "@/components/status-pill";
import { Modal } from "@/components/modal";
import { cronToSchedule, scheduleToCron, scheduleUnits, type ScheduleUnit } from "@/lib/schedule";
import { sourceRegistry } from "@/server/discovery/registry";
import { getIntegrationStatus, integrationStatusLabels, integrationStatusTone, CUSTOM_ADAPTER_PROVIDERS } from "@/server/providers/wiring";

const tabs = ["General", "LiteLLM", "Providers", "Automation", "Free Model Sources", "Safety"] as const;
type Tab = (typeof tabs)[number];
type Provider = {id: string; name: string; slug: string; enabled: boolean; credentialState: string; lastValidatedAt: string | null; environmentVariable: string; testSupported: boolean; portal: {url: string; label: string} | null; modelCount: number; config: Record<string, string>};
type Job = {type: string; enabled: boolean; schedule: string; customSchedule: boolean; defaultSchedule: string | null; timezone: string; status: string; lastRunAt: string | null; nextRunAt: string | null; durationMs: number | null; failureCount: number; lastError: string | null};

const jobTypeLabels: Record<string, string> = {
  MODEL_DISCOVERY: "Model Discovery",
  CANDIDATE_VERIFICATION: "Candidate Verification",
  HEALTH_MONITOR: "Health Monitor",
  RATE_LIMIT_LEARNING: "Rate Limit Learning",
  PROVIDER_VERIFICATION: "Provider Verification",
  APPLY_APPROVED_PLANS: "Apply Approved Plans",
  DEEP_BENCHMARK: "Full Health Sweep (Daily)",
  LANE_RECONCILE: "Lane Routing Reconcile",
  MAINTENANCE: "Maintenance",
};
const jobTypeDescriptions: Record<string, string> = {
  MODEL_DISCOVERY: "Scans provider catalogs for new free or discounted models.",
  CANDIDATE_VERIFICATION: "Tests discovered candidates directly against their provider for availability.",
  HEALTH_MONITOR: "Frequent connectivity checks against a rotating slice of live LiteLLM deployments.",
  RATE_LIMIT_LEARNING: "Probes provider rate limits to refine safe RPM/TPM estimates.",
  PROVIDER_VERIFICATION: "Re-checks every enabled provider's credential against a safe, low-cost endpoint, keeping the Providers page status current automatically instead of only on manual click.",
  APPLY_APPROVED_PLANS: "Applies validated LiteLLM configuration changes.",
  DEEP_BENCHMARK: "The same health check as Health Monitor, run against nearly the entire inventory once a day — this is what populates the Benchmarks page.",
  LANE_RECONCILE: "Re-adds any smart-* lane member missing from LiteLLM and re-pushes the cross-lane fallback chains.",
  MAINTENANCE: "Cleans up expired leases and stale internal state.",
};
type SourceYield = {source: string; discovered: number; verifiedFree: number; promoted: number; providers: string[]};
type SourceHistoryPoint = {at: string; status: "succeeded" | "failed"; detail: string};
type Source = {id: string; name: string; type: string; providerId: string | null; url: string | null; enabled: boolean; priority: number; status: string; discoveredModelCount: number; lastSyncAt: string | null; adapterReference: string | null; credentialReference: string | null; tier: "A1" | "A2" | "B" | "C" | null; yield: SourceYield | null; history: SourceHistoryPoint[]};
const tierRank: Record<string, number> = {A1: 0, A2: 1, B: 2, C: 3};
const tierTone: Record<string, string> = {A1: "good", A2: "info", B: "warn", C: "neutral"};

const builtinSourceDescriptions: Record<string, string> = Object.fromEntries(sourceRegistry.map(source => [source.id, source.description]));
const candidateOnlyByAdapterReference: Record<string, boolean> = Object.fromEntries(sourceRegistry.map(source => [source.id, Boolean(source.candidateOnly)]));
type Lane = {slug: string; minimumHealthy: number};

const stamp = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "—";
function StampCell({label, value}: {label: string; value: string | null | undefined}) {
  if (!value) return <div><small>{label}</small><strong>—</strong></div>;
  const date = new Date(value);
  return <div><small>{label}</small><strong>{date.toLocaleDateString()}</strong><span className="automation-job-stat-time">{date.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}</span></div>;
}

function Card({title, children, aside}: {title: string; children: React.ReactNode; aside?: React.ReactNode}) {
  return <section className="panel settings-card"><div className="panel-header"><h3>{title}</h3>{aside}</div><div className="panel-body">{children}</div></section>;
}
function History({items, label}: {items: StatusHistoryItem[]; label: string}) {
  return <div className="history-row"><StatusHistoryStrip label={label} items={items.slice(0, 14)}/></div>;
}

function ScheduleEditor({schedule, defaultCron, customized, jobType, disabled, onSave, onReset}: {schedule: string; defaultCron: string | null; customized: boolean; jobType: string; disabled: boolean; onSave: (cron: string) => void; onReset: () => void}) {
  const parsed = cronToSchedule(schedule);
  const [custom, setCustom] = useState(parsed === null);
  const [n, setN] = useState(parsed?.n ?? 1);
  const [unit, setUnit] = useState<ScheduleUnit>(parsed?.unit ?? "HOUR");
  const [trackedSchedule, setTrackedSchedule] = useState(schedule);

  if (schedule !== trackedSchedule) {
    setTrackedSchedule(schedule);
    setCustom(parsed === null);
    if (parsed) { setN(parsed.n); setUnit(parsed.unit); }
  }

  const resetHint = customized && defaultCron ? <button type="button" className="button small" disabled={disabled} onClick={onReset}>Reset to default ({defaultCron})</button> : null;

  if (custom) return <div className="schedule-picker">
    <input aria-label={`${jobType} cron schedule`} className="input compact-input" defaultValue={schedule} disabled={disabled} onBlur={event => { if (event.target.value.trim() && event.target.value.trim() !== schedule) onSave(event.target.value.trim()); }}/>
    <button type="button" className="button" disabled={disabled} onClick={() => { const seed = (defaultCron && cronToSchedule(defaultCron)) || {n: 1, unit: "HOUR" as ScheduleUnit}; setN(seed.n); setUnit(seed.unit); setCustom(false); }}>Use simple schedule</button>
    {resetHint}
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
    {resetHint}
  </div>;
}

export function SettingsClient({environment, lanes, laneOverview, initialHistory, smokeHistory}: {environment: string; lanes: Lane[]; laneOverview: LaneOverviewItem[]; initialHistory: StatusHistoryItem[]; smokeHistory: StatusHistoryItem[]}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as Tab | null;
  const [active, setActive] = useState<Tab>(tabParam && tabs.includes(tabParam) ? tabParam : "General");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);
  const [sourceModal, setSourceModal] = useState<null | {mode: "add"} | {mode: "edit"; source: Source}>(null);
  const [addProviderModal, setAddProviderModal] = useState(false);
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

  function refreshJobHistory() {
    request("/api/settings/automation/history").then((items: StatusHistoryItem[]) => setJobHistory(items)).catch(() => {});
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
      refreshJobHistory();
    } catch (error) {
      setJobHistory(current => [{at: new Date().toISOString(), status: "FAILED", label: type, detail: error instanceof Error ? error.message : undefined}, ...current]);
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (active !== "Automation") return;
    let live = true;
    request("/api/settings/automation/history").then((items: StatusHistoryItem[]) => { if (live) setJobHistory(items); }).catch(() => {});
    return () => { live = false; };
  }, [active]);

  useEffect(() => {
    const endpoint = active === "Providers" ? "/api/settings/providers" : active === "Automation" ? "/api/settings/automation" : active === "Free Model Sources" ? "/api/settings/model-sources" : null;
    if (!endpoint) return;
    let current = true;
    const timer = setTimeout(() => {
      setLoading(true); setMessage("");
      request(endpoint).then(value => {
        if (!current) return;
        if (active === "Providers") setProviders(value);
        else if (active === "Automation") setJobs(value);
        else setSources(value);
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
      if (active === "Free Model Sources") setSources(await request("/api/settings/model-sources"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  }

  // Real per-run history (mined from past MODEL_DISCOVERY runs) when there is any; a source with no adapterReference
  // (a custom source, not fed by the Model Discovery job) or one that's never actually run yet falls back to a
  // single point synthesized from its current status, same as before.
  const sourceHistory = (source: Source) => source.history.length ? source.history
    : source.lastSyncAt ? [{at: source.lastSyncAt, status: source.status, label: source.name, detail: `${source.discoveredModelCount} discovered models`}] : [];

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
        <dt>Application</dt><dd>RatLLM</dd>
        <dt>Environment</dt><dd>{environment}</dd>
        <dt>Credential storage</dt><dd>Server environment variables or encrypted server-side secrets. Saving a replacement never displays the stored secret.</dd>
      </dl></Card>
    </div>}

    {active === "LiteLLM" && <div className="settings-grid"><LiteLLMConnectionForm/><LiteLLMManagementForm/><LiteLLMLaneSetupPanel lanes={laneOverview}/></div>}

    {active === "Providers" && <Card title="Provider credentials" aside={<button className="button primary" type="button" onClick={() => setAddProviderModal(true)}>Add provider</button>}><div className="settings-table-wrap"><table className="data-table settings-table"><thead><tr><th>Provider</th><th>Enabled</th><th>Credential</th><th>Integration</th><th>Last credential test</th><th>Actions</th></tr></thead><tbody>
      {providers.map(provider => {
        const integration = getIntegrationStatus(provider.slug, {configured: provider.credentialState !== "MISSING", verified: provider.credentialState === "CONFIGURED"}, provider.modelCount > 0);
        const needsCustomAdapter = integration === "NEEDS_CUSTOM_ADAPTER";
        return <tr key={provider.id}>
        <td><strong>{provider.name}</strong></td>
        <td><input type="checkbox" aria-label={`Enable ${provider.name}`} checked={provider.enabled} disabled={busy} onChange={event => void act(() => request("/api/settings/providers", {method: "PATCH", body: JSON.stringify({id: provider.id, enabled: event.target.checked})}))}/></td>
        <td><StatusPill value={provider.credentialState}/></td>
        <td><span className={`status-pill status-${integrationStatusTone[integration]}`}>{integrationStatusLabels[integration]}</span>{needsCustomAdapter && <br/>}{needsCustomAdapter && <small className="settings-help">{CUSTOM_ADAPTER_PROVIDERS[provider.slug]}</small>}</td>
        <td>{stamp(provider.lastValidatedAt)}</td>
        <td><div className="settings-actions">
          {needsCustomAdapter ? <span className="settings-help">Not yet supported for automated verification</span> : <button className="button" type="button" onClick={() => setEditing(editing === provider.id ? null : provider.id)}>Configure credential</button>}
          {provider.testSupported ? <button className="button" type="button" disabled={busy || !provider.enabled || provider.credentialState === "MISSING"} onClick={() => void act(async () => { await request(`/api/providers/${provider.id}/verify`, {method: "POST"}); })}>Test credential</button> : !needsCustomAdapter && <span className="settings-help">API test unavailable</span>}
          {provider.enabled && <button className="button small" type="button" disabled={busy} onClick={() => setDeletingProvider(provider.id)}>Delete</button>}
        </div></td>
      </tr>;
      })}
    </tbody></table></div>
    </Card>}
    <Modal open={editing !== null} title={`${providers.find(p => p.id === editing)?.name ?? ""} credential`} onClose={() => setEditing(null)}>
      {editing && providers.find(p => p.id === editing)?.portal && <p className="settings-help"><a href={providers.find(p => p.id === editing)!.portal!.url} target="_blank" rel="noopener noreferrer">{providers.find(p => p.id === editing)!.portal!.label} on {providers.find(p => p.id === editing)?.name} ↗</a></p>}
      {editing && <CredentialForm providerId={editing} defaultEnv={providers.find(p => p.id === editing)!.environmentVariable} slug={providers.find(p => p.id === editing)!.slug} defaultConfig={providers.find(p => p.id === editing)!.config}/>}
    </Modal>
    <Modal open={deletingProvider !== null} title={`Delete ${providers.find(p => p.id === deletingProvider)?.name ?? ""}`} onClose={() => setDeletingProvider(null)}>
      <p className="settings-help">This deactivates the provider — it stops appearing as available for discovery and verification, but its credential, deployments, and history stay in the database. You can re-enable it any time from the Enabled column.</p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={() => setDeletingProvider(null)}>Cancel</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => void act(async () => { await request("/api/settings/providers", {method: "PATCH", body: JSON.stringify({id: deletingProvider, enabled: false})}); setDeletingProvider(null); })}>Delete</button>
      </div>
    </Modal>

    {active === "Automation" && <Card title="Automation jobs" aside={<span>Database-backed scheduler</span>}>
      <p className="settings-help">Each job is claimed with a lease before execution, preventing overlap across worker restarts. Changes take effect when the worker next checks for due jobs.</p>
      <div className="automation-jobs">
        {jobs.map(job => <div className="automation-job-card" key={job.type}>
          <div className="automation-job-header">
            <div>
              <div className="automation-job-name">
                <input aria-label={`${job.type} enabled`} type="checkbox" checked={job.enabled} disabled={busy} onChange={event => void act(() => request(`/api/settings/automation?type=${job.type}`, {method: "PATCH", body: JSON.stringify({enabled: event.target.checked})}))}/>
                <strong>{jobTypeLabels[job.type] ?? job.type.replaceAll("_", " ")}</strong>
                <StatusPill value={job.status}/>
              </div>
              {jobTypeDescriptions[job.type] && <p className="automation-job-description">{jobTypeDescriptions[job.type]}</p>}
            </div>
            <div className="settings-actions">
              <button className="button" type="button" disabled={busy} onClick={() => void runJobNow(job.type)}>Run now</button>
              <Link className="button" href={`/runs?type=${job.type}`}>View runs</Link>
            </div>
          </div>
          <div className="automation-job-body">
            <div>
              <label className="settings-job-label">Schedule{job.customSchedule && <span className="settings-help" style={{marginLeft: 6}}>· customized</span>}</label>
              <ScheduleEditor
                schedule={job.schedule}
                defaultCron={job.defaultSchedule}
                customized={job.customSchedule}
                jobType={job.type}
                disabled={busy}
                onSave={cron => void act(() => request(`/api/settings/automation?type=${job.type}`, {method: "PATCH", body: JSON.stringify({schedule: cron})}))}
                onReset={() => void act(() => request(`/api/settings/automation?type=${job.type}`, {method: "PATCH", body: JSON.stringify({resetSchedule: true})}))}
              />
            </div>
            <div className="automation-job-stats">
              <StampCell label="Next run" value={job.nextRunAt}/>
              <StampCell label="Last run" value={job.lastRunAt}/>
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

    {active === "Free Model Sources" && <Card title="Free model sources" aside={<button className="button primary" type="button" onClick={() => setSourceModal({mode: "add"})}>Add source</button>}>
      <p className="settings-help">The built-in sources below are what the Model Discovery job actually scouts — disabling one here skips it on the next run. Custom sources you add are tested independently and do not yet feed discovery automatically. Sorted by trust tier: A1 (official live API) down to C (community list) — a source&apos;s Yield column is its actual track record, not just its tier&apos;s editorial claim.</p>
      <div className="settings-table-wrap"><table className="data-table settings-table"><thead><tr><th>Tier</th><th>Source</th><th>Type</th><th>Enabled</th><th>Status</th><th>Last sync</th><th>Yield</th><th>History</th><th></th></tr></thead><tbody>
        {[...sources].sort((a, b) => (tierRank[a.tier ?? "C"] ?? 4) - (tierRank[b.tier ?? "C"] ?? 4)).map(source => <tr key={source.id}>
          <td>{source.tier ? <span className={`status-pill status-${tierTone[source.tier]}`}>{source.tier}</span> : <span className="settings-help">custom</span>}</td>
          <td><button type="button" className="settings-link-button" onClick={() => setSourceModal({mode: "edit", source})}>{source.name}</button>{source.adapterReference && <span className="settings-help" style={{marginLeft: 6}}>Built-in{candidateOnlyByAdapterReference[source.adapterReference] && " · candidate-only"}</span>}<br/><small>{source.adapterReference ? builtinSourceDescriptions[source.adapterReference] ?? source.url : source.url ?? "Manual source"}</small></td>
          <td>{source.type.replaceAll("_", " ")}</td>
          <td><input aria-label={`${source.name} enabled`} type="checkbox" checked={source.enabled} disabled={busy} onChange={event => void act(() => request("/api/settings/model-sources", {method: "POST", body: JSON.stringify({...source, enabled: event.target.checked})}))}/></td>
          <td><StatusPill value={source.status}/>{source.status==="DEGRADED"&&<><br/><small>0 models found</small></>}</td>
          <td>{stamp(source.lastSyncAt)}</td>
          <td>{source.yield ? <div>
            <div className="mono" style={{fontSize:11,whiteSpace:"nowrap"}}>{source.yield.discovered} found <span style={{color:"var(--faint)"}}>→</span> {source.yield.verifiedFree} verified <span style={{color:"var(--faint)"}}>→</span> {source.yield.promoted} promoted</div>
            {source.yield.providers.length>0 && <details style={{marginTop:3}}>
              <summary style={{cursor:"pointer",fontSize:10,color:"var(--faint)"}}>{source.yield.providers.length} provider{source.yield.providers.length===1?"":"s"} touched</summary>
              <p style={{margin:"4px 0 0",fontSize:10,color:"var(--faint)"}}>{source.yield.providers.join(", ")}</p>
            </details>}
          </div> : <span className="settings-help">no candidates yet</span>}</td>
          <td><StatusHistoryStrip label={`${source.name} sync history`} items={sourceHistory(source)}/></td>
          <td style={{textAlign: "right"}}>{!source.adapterReference && <button className="button small" type="button" disabled={busy} onClick={() => void act(() => request(`/api/settings/model-sources?id=${source.id}`, {method: "DELETE"}))}>Delete</button>}</td>
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

    <Modal open={sourceModal !== null} title={sourceModal?.mode === "edit" ? sourceModal.source.name : "Add model source"} onClose={() => setSourceModal(null)}>
      {sourceModal?.mode === "edit" ? (() => {
        const source = sourceModal.source;
        const registryEntry = source.adapterReference ? sourceRegistry.find(item => item.id === source.adapterReference) : undefined;
        return <form onSubmit={event => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const name = String(fields.get("name") ?? "").trim();
          if (!name) return;
          const patch: Partial<Source> = {name, priority: Number(fields.get("priority") ?? source.priority)};
          if (!registryEntry) { patch.url = String(fields.get("url") ?? "").trim() || null; patch.credentialReference = String(fields.get("credentialReference") ?? "").trim() || null; }
          void act(() => request("/api/settings/model-sources", {method: "POST", body: JSON.stringify({...source, ...patch})}));
          setSourceModal(null);
        }}>
          {registryEntry && <p className="settings-help">{registryEntry.description}</p>}
          <label>Name<input className="input" name="name" required autoFocus defaultValue={source.name}/></label>
          <label>URL<input className="input" name="url" type="url" defaultValue={registryEntry?.url ?? source.url ?? ""} disabled={Boolean(registryEntry)}/>{registryEntry && <small>Reference only — the built-in adapter always queries this exact endpoint.</small>}</label>
          {!registryEntry && <label>Credential reference<input className="input" name="credentialReference" defaultValue={source.credentialReference ?? ""} placeholder="e.g. an environment variable name, if this feed needs one"/></label>}
          <label>Priority<input className="input" name="priority" type="number" min={0} max={10000} defaultValue={source.priority}/></label>
          <dl className="definition-list">
            <dt>Type</dt><dd>{source.type.replaceAll("_", " ")}{registryEntry && ` · Tier ${registryEntry.tier}${registryEntry.candidateOnly ? " (candidate-only)" : ""}`}</dd>
            {registryEntry?.authEnv && <><dt>Authentication</dt><dd>{registryEntry.authEnv} environment variable{registryEntry.authOptional ? " (optional — works unauthenticated too)" : " (required)"}</dd></>}
            {registryEntry?.registrationUrl && <><dt>Get credential</dt><dd><a href={registryEntry.registrationUrl} target="_blank" rel="noopener noreferrer">{registryEntry.registrationUrl} ↗</a></dd></>}
            <dt>Status</dt><dd>{source.status}</dd>
            <dt>Last sync</dt><dd>{stamp(source.lastSyncAt)}</dd>
            <dt>Discovered models</dt><dd>{source.discoveredModelCount}</dd>
          </dl>
          <div className="modal-actions">
            {!registryEntry && <button type="button" className="button" disabled={busy} onClick={() => void act(() => request("/api/settings/model-sources/action", {method: "POST", body: JSON.stringify({sourceId: source.id, action: "sync"})}))}>Test / sync now</button>}
            {!registryEntry && <button type="button" className="button" disabled={busy} onClick={() => { void act(() => request(`/api/settings/model-sources?id=${source.id}`, {method: "DELETE"})); setSourceModal(null); }}>Delete</button>}
            <button type="button" className="button" onClick={() => setSourceModal(null)}>Cancel</button>
            <button type="submit" className="button primary">Save</button>
          </div>
        </form>;
      })() : <form onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const name = String(fields.get("name") ?? "").trim();
        if (!name) return;
        const url = String(fields.get("url") ?? "").trim();
        const credentialReference = String(fields.get("credentialReference") ?? "").trim();
        void act(() => request("/api/settings/model-sources", {method: "POST", body: JSON.stringify({name, type: url ? "JSON_FEED" : "MANUAL", url: url || null, credentialReference: credentialReference || null, enabled: true, priority: 100})}));
        setSourceModal(null);
      }}>
        <label>Source name<input className="input" name="name" required autoFocus/></label>
        <label>Source URL<input className="input" name="url" type="url" placeholder="Leave blank for a Manual source"/></label>
        <label>Credential reference<input className="input" name="credentialReference" placeholder="e.g. an environment variable name, if this feed needs one"/></label>
        <div className="modal-actions"><button type="button" className="button" onClick={() => setSourceModal(null)}>Cancel</button><button type="submit" className="button primary">Add source</button></div>
      </form>}
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

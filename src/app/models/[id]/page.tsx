import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { CopyableId } from "@/components/copyable-id";
import { duration, timeAgo } from "@/lib/utils";
import { demoDeployments } from "@/server/demo-data";
import { getDeploymentDetail } from "@/server/deployment-detail";
import { getDeployment, withDemo } from "@/server/queries";
import { SmokeButton } from "./smoke-button";
import { DeploymentActions } from "@/app/litellm/deployment-actions";

export const dynamic = "force-dynamic";

const METADATA_PREVIEW_CHARS = 8000;

function When({ at }: { at: Date | null | undefined }) {
  if (!at) return <>Never</>;
  return <time dateTime={at.toISOString()} title={at.toISOString()}>{timeAgo(at)}</time>;
}

function hostOf(url: string | null) {
  if (!url) return null;
  try { return new URL(url).host; } catch { return url; }
}

export default async function ModelDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await withDemo(() => getDeployment(id), () => demoDeployments.find(item => item.id === id) ?? null);
  if (!row) notFound();
  const detail = await withDemo(() => getDeploymentDetail(id), () => null);

  const lifecycle = row.lifecycle ?? "ACTIVE";
  const removed = lifecycle === "REMOVED";
  const metadataJson = detail ? JSON.stringify(detail.rawMetadata, null, 2) : "";
  const siblingCount = detail?.siblings.length ?? 0;

  return <PageShell title={row.modelName} eyebrow={`${row.providerName} · ${row.providerModelId}`} actions={<SmokeButton deploymentId={row.id} model={row.litellmModelName} />}>
    <div className="detail-grid">
      <section className="panel">
        <div className="panel-header">
          <h3>Identity</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <StatusPill value={row.health} />
            <DeploymentActions id={row.id} alias={row.litellmModelName} health={row.health} live={Boolean(row.litellmDeploymentId)} />
          </div>
        </div>
        <div className="panel-body">
          <dl className="definition-list">
            <dt>{removed ? "Last known LiteLLM ID" : "LiteLLM ID"}</dt>
            <dd>
              {row.litellmDeploymentId
                ? <CopyableId value={row.litellmDeploymentId} label="LiteLLM ID" />
                : <span className="settings-help">None — this deployment has no router ID recorded</span>}
              <div className="settings-help">The router&apos;s own ID for this exact deployment. Health checks, blocking and deletion all address this ID, never the alias.</div>
              {removed && <div className="settings-help">This deployment is no longer in the router; the ID is kept for history and is not probed.</div>}
            </dd>

            <dt>RatLLM ID</dt>
            <dd><CopyableId value={row.id} label="RatLLM ID" /></dd>

            <dt>LiteLLM instance</dt>
            <dd>{detail?.instanceBaseUrl ? <code className="mono">{hostOf(detail.instanceBaseUrl)}</code> : <span className="settings-help">Not configured</span>}</dd>

            <dt>Alias</dt>
            <dd>
              <code className="mono">{row.litellmModelName}</code>
              <div className="settings-help">
                {detail ? (siblingCount ? `Shared with ${siblingCount} other deployment${siblingCount === 1 ? "" : "s"} — see the alias pool below.` : "The only deployment behind this alias.") : "Router model name."}
              </div>
            </dd>

            <dt>Provider model</dt>
            <dd><code className="mono">{row.providerModelId}</code></dd>

            <dt>Provider</dt>
            <dd>{row.providerName}{row.backend ? <> · <span className="mono">{row.backend}</span></> : null}{row.apiBase ? <div className="settings-help mono">{row.apiBase}</div> : null}</dd>

            <dt>Canonical model</dt>
            <dd>{row.slug}</dd>

            <dt>Ownership</dt>
            <dd>
              {row.managed ? "Managed by RatLLM" : "Unmanaged · read only"}
              {row.managed && (row.managedBy || row.curatorVersion) ? <div className="settings-help">{[row.managedBy, row.curatorVersion && `v${row.curatorVersion}`].filter(Boolean).join(" · ")}</div> : null}
            </dd>

            <dt>Lifecycle</dt>
            <dd>
              <StatusPill value={lifecycle} />{detail?.blocked ? <> <StatusPill value="BLOCKED" tooltip="Blocked at the router: still listed, but excluded from routing." /></> : null}
              {detail?.removedReason ? <div className="settings-help">{detail.removedReason}</div> : null}
            </dd>

            {detail && detail.failureStreak > 0 && <>
              <dt>Failure streak</dt>
              <dd>{detail.failureStreak} consecutive failed check{detail.failureStreak === 1 ? "" : "s"} <span className="settings-help">(rate limits don&apos;t count)</span></dd>
            </>}

            <dt>First seen</dt>
            <dd><When at={row.firstSeenAt} /></dd>
            <dt>Last seen in inventory</dt>
            <dd><When at={row.lastSeenAt} /></dd>
            <dt>Last tested</dt>
            <dd><When at={row.lastTestedAt} /></dd>
            <dt>Score</dt>
            <dd>{row.score?.toFixed(1) ?? "Not scored"}</dd>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h3>Rate limit evidence</h3><StatusPill value={row.confidence} /></div>
        <div className="panel-body metric-card-grid">
          <div className="metric-card"><small>Documented</small><strong>{row.rpmLimit ?? "—"} RPM</strong><p>{row.tpmLimit?.toLocaleString() ?? "—"} TPM · fact</p></div>
          <div className="metric-card"><small>Observed</small><strong>— RPM</strong><p>Not measured</p></div>
          <div className="metric-card"><small>Safe configured</small><strong>{row.safeRpm ?? "—"} RPM</strong><p>{row.safeTpm?.toLocaleString() ?? "—"} TPM · manual</p></div>
        </div>
        <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 14 }}>Observed and safe limits are not measured yet, so they show a dash. Manual overrides are never replaced.</p>
      </section>
    </div>

    {detail && <>
      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-header"><h3>Alias pool</h3><span>{siblingCount ? `${siblingCount + 1} deployments share “${row.litellmModelName}”` : "Single deployment"}</span></div>
        <div className="panel-body">
          {siblingCount ? <div className="settings-table-wrap"><table className="data-table"><thead><tr><th>LiteLLM ID</th><th>Provider model</th><th>Provider</th><th>Lifecycle</th><th>Health</th><th>Ownership</th></tr></thead><tbody>
            {detail.siblings.map(sibling => <tr key={sibling.id}>
              <td><Link href={`/models/${sibling.id}`}><CopyableId value={sibling.litellmDeploymentId} compact label="LiteLLM ID" /></Link></td>
              <td className="mono">{sibling.providerModelId}</td>
              <td>{sibling.providerName}</td>
              <td><StatusPill value={sibling.lifecycle} /></td>
              <td><StatusPill value={sibling.health} /></td>
              <td>{sibling.managed ? "Managed" : "Unmanaged"}</td>
            </tr>)}
          </tbody></table></div>
            : <p className="settings-help">No other deployment uses this alias, so the alias and this deployment&apos;s LiteLLM ID currently point at the same thing.</p>}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-header"><h3>Lanes</h3><span>{detail.lanes.length} membership{detail.lanes.length === 1 ? "" : "s"}</span></div>
        <div className="panel-body">
          {detail.lanes.length ? <div className="settings-table-wrap"><table className="data-table"><thead><tr><th>Lane</th><th>Priority</th><th>State</th></tr></thead><tbody>
            {detail.lanes.map(lane => <tr key={lane.slug}>
              <td><Link href="/lanes">{lane.name}</Link> <span className="mono settings-help">{lane.slug}</span></td>
              <td>{lane.priority}</td>
              <td>{lane.excluded ? <StatusPill value="EXCLUDED" /> : lane.pinned ? <StatusPill value="PINNED" /> : <StatusPill value="ACTIVE" />}</td>
            </tr>)}
          </tbody></table></div> : <p className="settings-help">Not assigned to any lane.</p>}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-header"><h3>Recent checks</h3><span>{row.litellmDeploymentId ? "Probed by exact LiteLLM ID" : "No probe target"}</span></div>
        <div className="panel-body">
          {detail.probes.length ? <div className="settings-table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Result</th><th>HTTP</th><th>Response</th><th>First token</th><th>Error</th></tr></thead><tbody>
            {detail.probes.map((probe, index) => <tr key={index}>
              <td><When at={probe.at} /></td>
              <td><StatusPill value={probe.httpStatus === 429 ? "RATE_LIMITED" : probe.status} /></td>
              <td className="mono">{probe.httpStatus ?? "—"}</td>
              <td className="mono">{probe.latencyMs != null ? duration(probe.latencyMs) : "—"}</td>
              <td className="mono">{probe.firstTokenMs != null ? duration(probe.firstTokenMs) : "—"}</td>
              <td className="settings-help">{probe.error ? probe.error.slice(0, 140) : ""}</td>
            </tr>)}
          </tbody></table></div> : <p className="settings-help">No checks recorded yet.</p>}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-header"><h3>Activity</h3><span>Audit trail for this deployment</span></div>
        <div className="panel-body">
          {detail.audit.length ? <div className="settings-table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Correlation ID</th></tr></thead><tbody>
            {detail.audit.map((event, index) => <tr key={index}>
              <td><When at={event.at} /></td>
              <td className="mono">{event.action}</td>
              <td>{event.actor}</td>
              <td className="mono settings-help">{event.correlationId}</td>
            </tr>)}
          </tbody></table></div> : <p className="settings-help">No recorded actions yet.</p>}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-header"><h3>Router metadata</h3><span>Sanitized — secrets removed</span></div>
        <div className="panel-body">
          <details>
            <summary style={{ cursor: "pointer" }}>Show what LiteLLM reports for this deployment</summary>
            <pre className="mono" style={{ fontSize: 11, overflow: "auto", maxHeight: 420, marginTop: 10 }}>
              {metadataJson.length > METADATA_PREVIEW_CHARS ? `${metadataJson.slice(0, METADATA_PREVIEW_CHARS)}\n… (${metadataJson.length - METADATA_PREVIEW_CHARS} more characters not shown)` : metadataJson}
            </pre>
          </details>
        </div>
      </section>
    </>}

    <section className="panel" style={{ marginTop: 14 }}>
      <div className="panel-header"><h3>Capabilities and observations</h3><span>Normalized metadata</span></div>
      <div className="panel-body">
        <p style={{ color: "var(--muted)", fontSize: 11 }}>
          Capability evidence will appear after deterministic benchmark suites complete. This deployment was last measured {timeAgo(row.lastTestedAt)}; average response {row.avgLatencyMs != null ? duration(row.avgLatencyMs) : "not yet measured"}.
        </p>
      </div>
    </section>
  </PageShell>;
}

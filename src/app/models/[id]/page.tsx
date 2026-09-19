import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { CopyableId } from "@/components/copyable-id";
import { duration, timeAgo } from "@/lib/utils";
import { demoDeployments } from "@/server/demo-data";
import { getDeploymentDetail } from "@/server/deployment-detail";
import { getDeployment, withDemo } from "@/server/queries";
import { findDuplicateGroups } from "@/server/litellm/duplicates";
import { SmokeButton } from "./smoke-button";
import { DeploymentActions } from "@/app/litellm/deployment-actions";

export const dynamic = "force-dynamic";

const METADATA_PREVIEW_CHARS = 8000;

/** Absolute UTC date (what you'd paste into a ticket) with the relative age beside it. */
function When({ at, relative = true }: { at: Date | string | null | undefined; relative?: boolean }) {
  if (!at) return <>Never</>;
  const date = new Date(at);
  const absolute = `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  return <time dateTime={date.toISOString()} title={date.toISOString()}>{absolute}{relative ? <span className="settings-help"> · {timeAgo(date)}</span> : null}</time>;
}

const yesNo = (value: boolean | null | undefined) => value === true ? "Yes" : value === false ? "No" : "Unknown";

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
  // Other live copies of this same model behind this same alias (an alias pool can hold many *different* models; that's
  // normal — identical copies are the problem).
  const duplicateGroup = detail && lifecycle === "ACTIVE" ? findDuplicateGroups([
    { id: row.id, litellmModelName: row.litellmModelName, providerName: row.providerName, providerModelId: row.providerModelId, lifecycle, litellmDeploymentId: row.litellmDeploymentId },
    ...detail.siblings.map(sibling => ({ id: sibling.id, litellmModelName: row.litellmModelName, providerName: sibling.providerName, providerModelId: sibling.providerModelId, lifecycle: sibling.lifecycle, litellmDeploymentId: sibling.litellmDeploymentId })),
  ]).find(group => group.ids.includes(row.id)) : undefined;

  return <PageShell title={row.modelName} eyebrow={`${row.providerName} · ${row.providerModelId}`} actions={<SmokeButton deploymentId={row.id} model={row.litellmModelName} />}>
    {duplicateGroup && <p role="alert" className="settings-feedback" style={{ borderColor: "var(--amber)", marginBottom: 14 }}>
      <strong>Deployed {duplicateGroup.count} times.</strong> {row.providerModelId} has {duplicateGroup.count} live copies behind “{row.litellmModelName}”, each with its own LiteLLM ID (listed under Alias pool). Identical copies add no capacity — they skew routing toward this model and multiply its rate-limit use. Delete the extra copies by LiteLLM ID.
    </p>}
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

            <dt>Discovered</dt>
            <dd>{detail?.discovery ? <><When at={detail.discovery.firstSeenAt} /><div className="settings-help">by {detail.discovery.sourceName}</div></> : <span className="settings-help">No discovery record found for this model</span>}</dd>
            <dt>Added to LiteLLM</dt>
            <dd>
              {detail?.addedToLiteLLMAt
                ? <><When at={detail.addedToLiteLLMAt} /><div className="settings-help">Promoted by RatLLM</div></>
                : <><When at={row.firstSeenAt} /><div className="settings-help">First seen in the LiteLLM inventory — no RatLLM promotion was recorded, so it was added another way</div></>}
            </dd>
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
        <div className="panel-header"><h3>Lifecycle</h3><span>From discovery to now</span></div>
        <div className="panel-body">
          {detail.timeline.length ? <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {detail.timeline.map((event, index) => <li key={index} style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 14 }}>
              <span className="mono settings-help"><When at={event.at} relative={false} /></span>
              <span>{event.label}{event.detail ? <span className="settings-help"> — {event.detail}</span> : null}</span>
            </li>)}
          </ol> : <p className="settings-help">No dated events recorded for this deployment.</p>}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-header"><h3>Discovery</h3><span>{detail.discovery ? (detail.discovery.link === "recorded" ? "Linked when RatLLM added it" : "Matched by provider and model name") : "No record"}</span></div>
        <div className="panel-body">
          {detail.discovery ? <dl className="definition-list">
            <dt>Source</dt>
            <dd>{detail.discovery.sourceName}{detail.discovery.sourceTier ? <> <span className="status-pill status-neutral">Tier {detail.discovery.sourceTier}</span></> : null}{detail.discovery.sourceUrl ? <div className="settings-help"><a href={detail.discovery.sourceUrl} target="_blank" rel="noreferrer noopener">{detail.discovery.sourceUrl}</a></div> : null}</dd>
            <dt>Free access</dt>
            <dd><StatusPill value={detail.discovery.freeType} /> {detail.discovery.verifiedFree ? <StatusPill value="VERIFIED FREE" /> : <span className="settings-help">not verified free by the source</span>}</dd>
            <dt>Discovered</dt>
            <dd><When at={detail.discovery.firstSeenAt} /></dd>
            <dt>Last seen by discovery</dt>
            <dd><When at={detail.discovery.lastSeenAt} /></dd>
            <dt>Direct provider checks</dt>
            <dd>{detail.discovery.checks && detail.discovery.checks.total ? <>{detail.discovery.checks.passed} of {detail.discovery.checks.total} passed
              <div className="settings-help">First pass <When at={detail.discovery.checks.firstPassAt} /> · last check <When at={detail.discovery.checks.lastAt} /></div></> : <span className="settings-help">No direct checks recorded</span>}</dd>
            <dt>Context window</dt>
            <dd>{detail.discovery.contextWindow?.toLocaleString() ?? "Unknown"}{detail.discovery.maxOutputTokens ? <span className="settings-help"> · up to {detail.discovery.maxOutputTokens.toLocaleString()} output tokens</span> : null}</dd>
            <dt>Capabilities</dt>
            <dd>Vision: {yesNo(detail.discovery.supportsVision)} · Tools: {yesNo(detail.discovery.supportsTools)} · Reasoning: {yesNo(detail.discovery.supportsReasoning)}</dd>
            <dt>Also reported by</dt>
            <dd>{detail.discovery.corroborating.length ? detail.discovery.corroborating.map(item => item.source).join(", ") : <span className="settings-help">No other source</span>}</dd>
            <dt>Discovery record</dt>
            <dd><CopyableId value={detail.discovery.candidateId} label="discovery record ID" /></dd>
          </dl> : <p className="settings-help">No discovery record matches this deployment. It was likely added directly in LiteLLM, or discovered before records were kept.</p>}
        </div>
      </section>

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

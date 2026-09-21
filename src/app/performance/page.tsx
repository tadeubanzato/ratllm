import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { duration, timeAgo } from "@/lib/utils";
import { getDeployments, withDemo } from "@/server/queries";
import { getPerformanceRows } from "@/server/performance";
import { buildPerformanceRows, summarizePerformance } from "@/server/performance-rules";
import { checkAgainstRouter, IN_SYNC } from "@/server/litellm/router-check";
import { RouterCheckBanner } from "@/components/router-check-banner";
export const dynamic="force-dynamic";

const STAT_WINDOW = 20;

export default async function PerformancePage() {
 const deployments = await getDeployments();
 const [rows, router] = await Promise.all([
  withDemo(() => getPerformanceRows(STAT_WINDOW, deployments), () => buildPerformanceRows(deployments, new Map(), new Map())),
  withDemo(() => checkAgainstRouter(deployments), () => IN_SYNC),
 ]);
 const summary = summarizePerformance(rows);

 return <PageShell title="Performance" eyebrow="Live latency and reliability of every deployment in LiteLLM">
    <RouterCheckBanner router={router}/>
 <section className="system-strip">
 <div className="system-item"><div><small>INVENTORY</small><strong>{summary.deployments} deployments</strong></div></div>
 <div className="system-item"><div><small>PROBED IN LAST 24H</small><strong>{summary.checkedLast24h}/{summary.deployments}</strong></div></div>
 <div className="system-item"><div><small>PASSED</small><strong>{summary.passed}</strong></div></div>
 <div className="system-item"><div><small>FAILED</small><strong>{summary.failed}</strong></div></div>
 {summary.awaitingFirstProbe>0&&<div className="system-item"><div><small>AWAITING FIRST PROBE</small><strong>{summary.awaitingFirstProbe}</strong></div></div>}
 </section>
    <section className="panel">
      <div className="panel-header"><h3>Performance by deployment</h3><span>Automatic health-monitor probe · ranked by success rate over recent checks, then latency</span></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Model / alias</th><th>Provider</th><th>Result</th><th>Latency</th><th>Success rate</th><th>p50 / p95</th><th>First token</th><th>HTTP</th><th>Runs</th><th>Last tested</th></tr></thead><tbody>
        {rows.map(({d, t, displayStatus, stat}) => <tr key={d.id}>
          <td><strong>{d.modelName}</strong><br/><span className="mono">{d.litellmModelName}</span></td>
          <td>{d.providerName}</td>
          <td><StatusPill value={t ? displayStatus : "NOT RUN"}/>{t?.error && <><br/><span className="truncate" style={{fontSize: 10, color: "var(--muted)", maxWidth: 220}} title={t.error}>{t.error}</span></>}</td>
          <td className="mono">{t?.latencyMs ? duration(t.latencyMs) : "—"}</td>
          <td className="mono">{stat ? `${stat.successRate}% (${stat.samples})` : "—"}</td>
          <td className="mono">{stat?.p50LatencyMs != null ? `${duration(stat.p50LatencyMs)} / ${stat.p95LatencyMs != null ? duration(stat.p95LatencyMs) : "—"}` : "—"}</td>
          <td className="mono">{stat?.avgFirstTokenMs != null ? duration(stat.avgFirstTokenMs) : "—"}</td>
          <td className="mono">{t?.httpStatus || "—"}</td>
          <td className="mono">{d.benchmarkRunCount}</td>
          <td>{t ? timeAgo(t.createdAt) : "Never"}</td>
        </tr>)}
      </tbody></table></div>
      <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 10 }}>
        Success rate, p50/p95 latency, and average first-token time are computed over each deployment&apos;s last {STAT_WINDOW} smoke tests.
        First token requires a streaming-capable smoke test result and is blank until enough streamed runs have been recorded.
      </p>
    </section>
  </PageShell>;
}

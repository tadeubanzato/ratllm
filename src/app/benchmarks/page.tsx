import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { duration, timeAgo } from "@/lib/utils";
import { getBenchmarkStats, getDeployments, getSmokeTests, withDemo } from "@/server/queries";
import { healthFromSmokeResult } from "@/server/status";
export const dynamic="force-dynamic";

const STAT_WINDOW = 20;

export default async function BenchmarksPage() {
  const [deployments, tests, stats] = await Promise.all([getDeployments(), withDemo(() => getSmokeTests(250), () => []), withDemo(() => getBenchmarkStats(STAT_WINDOW), () => new Map())]);
  const latest = new Map<string, typeof tests[number]>();
  for (const t of tests) if (t.deploymentId && !latest.has(t.deploymentId)) latest.set(t.deploymentId, t);

  const rows = deployments.map(d => {
    const t = latest.get(d.id) ?? null;
    const displayStatus = t ? healthFromSmokeResult(t.status === "PASSED", t.httpStatus ?? 0, t.latencyMs ?? 0, t.error ?? undefined) : "NOT_RUN";
    const stat = stats.get(d.id) ?? null;
    return {d, t, displayStatus, stat};
  }).sort((a, b) => {
    // Effectiveness, not just current status: highest success rate over real sample history first (a model
    // passing 95% of its last 20 checks beats one that merely happens to be HEALTHY on its single latest check),
    // then lowest p50 latency, then lowest first-token time as a final tiebreaker. No stats yet sorts last.
    if (!a.stat && !b.stat) return 0;
    if (!a.stat) return 1;
    if (!b.stat) return -1;
    if (a.stat.successRate !== b.stat.successRate) return b.stat.successRate - a.stat.successRate;
    const ap50 = a.stat.p50LatencyMs, bp50 = b.stat.p50LatencyMs;
    if (ap50 !== bp50) { if (ap50 == null) return 1; if (bp50 == null) return -1; if (ap50 !== bp50) return ap50 - bp50; }
    const aFtt = a.stat.avgFirstTokenMs, bFtt = b.stat.avgFirstTokenMs;
    if (aFtt !== bFtt) { if (aFtt == null) return 1; if (bFtt == null) return -1; return aFtt - bFtt; }
    return 0;
  });

  const passed = rows.filter(row => row.displayStatus === "HEALTHY").length;
  const failed = rows.filter(row => row.displayStatus !== "HEALTHY" && row.displayStatus !== "NOT_RUN").length;

  return <PageShell title="Benchmarks" eyebrow="Live LiteLLM operational evaluation">
    <section className="system-strip">
      <div className="system-item"><div><small>INVENTORY</small><strong>{deployments.length} deployments</strong></div></div>
      <div className="system-item"><div><small>CHECK COVERAGE</small><strong>{new Set(tests.map(t => t.deploymentId).filter(Boolean)).size}/{deployments.length}</strong></div></div>
      <div className="system-item"><div><small>PASSED</small><strong>{passed}</strong></div></div>
      <div className="system-item"><div><small>FAILED</small><strong>{failed}</strong></div></div>
    </section>
    <section className="panel">
      <div className="panel-header"><h3>Operational benchmark results</h3><span>Automatic health-monitor probe · ranked by success rate over recent checks, then latency</span></div>
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

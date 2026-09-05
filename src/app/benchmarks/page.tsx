import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { duration, timeAgo } from "@/lib/utils";
import { getDeployments, getSmokeTests, withDemo } from "@/server/queries";
import { healthFromSmokeResult } from "@/server/status";
export const dynamic="force-dynamic";

const rank: Record<string, number> = {HEALTHY: 0, DEGRADED: 1, RATE_LIMITED: 2, AUTH_ERROR: 3, UNAVAILABLE: 4, NOT_RUN: 5};

export default async function BenchmarksPage() {
  const [deployments, tests] = await Promise.all([getDeployments(), withDemo(() => getSmokeTests(250), () => [])]);
  const latest = new Map<string, typeof tests[number]>();
  for (const t of tests) if (t.deploymentId && !latest.has(t.deploymentId)) latest.set(t.deploymentId, t);

  const rows = deployments.map(d => {
    const t = latest.get(d.id) ?? null;
    const displayStatus = t ? healthFromSmokeResult(t.status === "PASSED", t.httpStatus ?? 0, t.latencyMs ?? 0, t.error ?? undefined) : "NOT_RUN";
    return {d, t, displayStatus};
  }).sort((a, b) => (rank[a.displayStatus] ?? 9) - (rank[b.displayStatus] ?? 9));

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
      <div className="panel-header"><h3>Operational benchmark results</h3><span>Automatic health-monitor probe · newest result per deployment, healthiest first</span></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Model / alias</th><th>Provider</th><th>Result</th><th>Latency</th><th>HTTP</th><th>Runs</th><th>Last tested</th></tr></thead><tbody>
        {rows.map(({d, t, displayStatus}) => <tr key={d.id}>
          <td><strong>{d.modelName}</strong><br/><span className="mono">{d.litellmModelName}</span></td>
          <td>{d.providerName}</td>
          <td><StatusPill value={t ? displayStatus : "NOT RUN"}/>{t?.error && <><br/><span style={{fontSize: 10, color: "var(--muted)"}}>{t.error.slice(0, 100)}</span></>}</td>
          <td className="mono">{t?.latencyMs ? duration(t.latencyMs) : "—"}</td>
          <td className="mono">{t?.httpStatus || "—"}</td>
          <td className="mono">{d.benchmarkRunCount}</td>
          <td>{t ? timeAgo(t.createdAt) : "Never"}</td>
        </tr>)}
      </tbody></table></div>
    </section>
  </PageShell>;
}

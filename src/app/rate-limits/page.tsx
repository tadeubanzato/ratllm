import { PageShell } from "@/components/page-shell";
import { getDeployments } from "@/server/queries";
import { timeAgo } from "@/lib/utils";
import { ManualOverride } from "./manual-override";
export const dynamic = "force-dynamic";

export default async function RateLimits() {
  const rows = await getDeployments();
  return <PageShell title="Rate Limits" eyebrow="Published, observed, safe, and manual limits">
    <section className="panel">
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>Deployment</th><th>Published</th><th>Observed</th><th>Safe</th><th>Manual override</th><th>Confidence</th><th>Last probe</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td>{row.litellmModelName}</td>
          <td className="mono">{row.rpmLimit ?? "—"}</td>
          <td className="mono">{row.observedRpm != null ? `${row.observedRpm} RPM` : "—"}{row.observedTpm != null && ` · ${row.observedTpm.toLocaleString()} TPM`}</td>
          <td className="mono">{row.safeRpm ?? "—"}</td>
          <td>{row.rateLimitProfileId ? <ManualOverride profileId={row.rateLimitProfileId} manualRpm={row.manualRpm} manualTpm={row.manualTpm}/> : "—"}</td>
          <td>{row.confidence}</td>
          <td>{row.lastProbeAt ? timeAgo(row.lastProbeAt) : "Never"}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 10 }}>
      Observed and Safe are learned from recent smoke-test evidence (429 rate) every 6 hours by the Rate Limit Learning automation.
      A manual override, once set, always takes precedence over learned values.
    </p>
  </PageShell>;
}

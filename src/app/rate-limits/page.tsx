import { PageShell } from "@/components/page-shell";
import { getDeployments } from "@/server/queries";
import { timeAgo } from "@/lib/utils";
export const dynamic = "force-dynamic";

export default async function RateLimits() {
  const rows = await getDeployments();
  return <PageShell title="Rate Limits" eyebrow="Published, observed, and safe limits — fully automated">
    <section className="panel">
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>Deployment</th><th>Published</th><th>Observed</th><th>Safe</th><th>Confidence</th><th>Last probe</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td>{row.litellmModelName}</td>
          <td className="mono">{row.rpmLimit ?? "—"}</td>
          <td className="mono">{row.observedRpm != null ? `${row.observedRpm} RPM` : "—"}{row.observedTpm != null && ` · ${row.observedTpm.toLocaleString()} TPM`}</td>
          <td className="mono">{row.safeRpm ?? "—"}</td>
          <td>{row.confidence}</td>
          <td>{row.lastProbeAt ? timeAgo(row.lastProbeAt) : "Never"}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <p style={{ fontSize: 10, color: "var(--muted)", marginTop: 10 }}>
      Observed and Safe are learned automatically from recent smoke-test evidence (429 rate) every 6 hours by the Rate Limit Learning automation. There is no manual override — every value on this page is machine-derived.
    </p>
  </PageShell>;
}

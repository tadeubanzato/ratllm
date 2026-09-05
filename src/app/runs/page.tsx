import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { duration, formatSummary, timeAgo } from "@/lib/utils";
import { demoRuns } from "@/server/demo-data";
import { getRuns, withDemo } from "@/server/queries";
export const dynamic="force-dynamic";
export default async function RunsPage({searchParams}: {searchParams: Promise<{type?: string}>}) {
  const {type} = await searchParams;
  const rows = await withDemo(() => getRuns({type, limit: type ? 50 : 12}), () => type ? demoRuns.filter(row => row.type === type) : demoRuns);
  return <PageShell title="Runs" eyebrow={type ? `Execution history · filtered to ${type.replaceAll("_"," ")}` : "Execution history"} actions={type ? <Link className="button" href="/runs">Clear filter</Link> : undefined}>
    <section className="panel"><div className="table-scroll"><table className="data-table"><thead><tr><th>Run ID</th><th>Type</th><th>Status</th><th>Started</th><th>Duration</th><th>Result</th></tr></thead><tbody>
      {rows.length ? rows.map(row=><tr key={row.id}><td className="mono"><strong>{row.id.slice(0,12)}</strong></td><td>{row.type.replaceAll("_"," ")}</td><td><StatusPill value={row.status}/></td><td>{timeAgo(row.createdAt)}</td><td className="mono">{duration(row.durationMs)}</td><td>{formatSummary(row.summary)||"—"}</td></tr>) : <tr><td colSpan={6}>No runs recorded{type ? ` for ${type.replaceAll("_"," ")} yet` : " yet"}.</td></tr>}
    </tbody></table></div></section>
  </PageShell>;
}

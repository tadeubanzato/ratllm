import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { duration, timeAgo } from "@/lib/utils";
import { demoRuns } from "@/server/demo-data";
import { getRuns, withDemo } from "@/server/queries";
export const dynamic="force-dynamic";
export default async function RunsPage(){const rows=await withDemo(getRuns,()=>demoRuns);return <PageShell title="Runs" eyebrow="Execution history"><section className="panel"><table className="data-table"><thead><tr><th>Run ID</th><th>Type</th><th>Status</th><th>Started</th><th>Duration</th><th>Result</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td className="mono"><strong>{row.id.slice(0,12)}</strong></td><td>{row.type.replaceAll("_"," ")}</td><td><StatusPill value={row.status}/></td><td>{timeAgo(row.createdAt)}</td><td className="mono">{duration(row.durationMs)}</td><td>{Object.entries(row.summary).map(([key,value])=>`${key} ${value}`).join(" · ")||"—"}</td></tr>)}</tbody></table></section></PageShell>}

import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { duration, formatSummary, timeAgo } from "@/lib/utils";
import { demoRuns } from "@/server/demo-data";
import { getRuns, getRunsCount, withDemo } from "@/server/queries";
export const dynamic="force-dynamic";

const PAGE_SIZE = 50;

export default async function RunsPage({searchParams}: {searchParams: Promise<{type?: string; page?: string}>}) {
  const {type, page: pageParam} = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [rows, total] = await withDemo(
    async () => [await getRuns({type, limit: PAGE_SIZE, offset}), await getRunsCount(type)] as const,
    () => { const all = type ? demoRuns.filter(row => row.type === type) : demoRuns; return [all.slice(offset, offset + PAGE_SIZE), all.length] as const; },
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const query = (targetPage: number) => `/runs?${new URLSearchParams({...(type ? {type} : {}), page: String(targetPage)}).toString()}`;
  return <PageShell title="Automation runs" eyebrow={type ? `Execution history · filtered to ${type.replaceAll("_"," ")} · ${total} total` : `Execution history · ${total} total`} actions={type ? <Link className="button" href="/runs">Clear filter</Link> : undefined}>
    <section className="panel"><div className="table-scroll"><table className="data-table"><thead><tr><th>Run ID</th><th>Type</th><th>Status</th><th>Started</th><th>Duration</th><th>Result</th></tr></thead><tbody>
      {rows.length ? rows.map(row=>{const summary=formatSummary(row.summary);return <tr key={row.id}><td className="mono"><Link href={`/runs/${row.id}`}><strong>{row.id.slice(0,12)}</strong></Link></td><td>{row.type.replaceAll("_"," ")}</td><td><StatusPill value={row.status}/></td><td>{timeAgo(row.createdAt)}</td><td className="mono">{duration(row.durationMs)}</td><td><span className="truncate" title={summary}>{summary||"—"}</span></td></tr>}) : <tr><td colSpan={6}>No runs recorded{type ? ` for ${type.replaceAll("_"," ")} yet` : " yet"}.</td></tr>}
    </tbody></table></div>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",gap:12,borderTop:"1px solid var(--border)"}}>
      <span style={{fontSize:11,color:"var(--muted)"}}>Page {page} of {totalPages}</span>
      <div style={{display:"flex",gap:8}}>
        {page > 1 ? <Link className="button small" href={query(page - 1)}>← Newer</Link> : <button className="button small" type="button" disabled>← Newer</button>}
        {page < totalPages ? <Link className="button small" href={query(page + 1)}>Older →</Link> : <button className="button small" type="button" disabled>Older →</button>}
      </div>
    </div>
    </section>
  </PageShell>;
}

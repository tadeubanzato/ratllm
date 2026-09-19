import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { CopyableId } from "@/components/copyable-id";
import { findDuplicateGroups } from "@/server/litellm/duplicates";
import { httpPromptDetail, UptimeBar, availabilityPercent } from "@/components/status-history-strip";
import { demoDeployments } from "@/server/demo-data";
import { getDeploymentSmokeHistory, getDeployments, withDemo, type SmokeHistoryPoint } from "@/server/queries";
import { duration, timeAgo } from "@/lib/utils";
import { DeploymentActions } from "./deployment-actions";
import { SyncButton } from "./sync-button";
export const dynamic="force-dynamic";
export default async function LiteLLMPage(){
  const rows=await withDemo(getDeployments,()=>demoDeployments);
  const history=await withDemo(() => getDeploymentSmokeHistory(20), () => new Map<string, SmokeHistoryPoint[]>());
  const duplicates=findDuplicateGroups(rows);const extraCopies=duplicates.reduce((sum,group)=>sum+group.count-1,0);
  const managed=rows.filter(r=>r.managed).length;const local=rows.filter(r=>r.backend?.toLowerCase()==="mlx").length;
  const pointsById=new Map(rows.map(row=>[row.id,(history.get(row.id)??[]).map(point=>({at:point.at,status:point.httpStatus===429?"RATE_LIMITED":point.status,detail:`${httpPromptDetail(point.httpStatus,point.status==="PASSED",point.error)} · ${point.latencyMs??"—"}ms`}))]));
  // Highest check % first; deployments with no check history yet sort last.
  const sorted=[...rows].sort((a,b)=>{
    const pa=availabilityPercent(pointsById.get(a.id)??[],20),pb=availabilityPercent(pointsById.get(b.id)??[],20);
    if(pa===pb)return 0;
    if(pa===null)return 1;
    if(pb===null)return -1;
    return pb-pa;
  });
  return <PageShell title="LiteLLM" eyebrow="Live production-router inventory" actions={<SyncButton/>}>{duplicates.length>0&&<section className="panel" style={{marginBottom:14,borderColor:"var(--amber)"}}><div className="panel-header"><h3>{duplicates.length} model{duplicates.length===1?" is":"s are"} deployed more than once</h3><span>{extraCopies} extra cop{extraCopies===1?"y":"ies"}</span></div><div className="panel-body"><p className="settings-help">The same model is live several times behind one alias through the same provider endpoint, so the copies share one rate limit and add no capacity. The same model from a different provider or endpoint is not counted. Open a model to see every copy and its LiteLLM ID.</p><ul style={{margin:"8px 0 0",paddingLeft:18}}>{duplicates.slice(0,12).map(group=><li key={group.alias+group.providerModelId}><Link href={`/models/${group.ids[0]}`}><span className="mono">{group.providerModelId}</span></Link> behind <span className="mono">{group.alias}</span> — {group.count} copies ({group.providerName})</li>)}</ul></div></section>}<section className="system-strip"><div className="system-item"><div><small>CONNECTION</small><strong>LiteLLM Proxy</strong></div><StatusPill value={rows.length?"Healthy":"Not synced"}/></div><div className="system-item"><div><small>DEPLOYMENTS</small><strong>{rows.length} live</strong></div></div><div className="system-item"><div><small>LOCAL MLX</small><strong>{local} deployments</strong></div></div><div className="system-item"><div><small>OWNERSHIP</small><strong>{managed} Curator managed</strong></div></div></section><section className="panel"><div className="panel-header"><h3>Live deployment inventory</h3><span>{rows.length-managed} unmanaged deployments preserved as read-only</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Alias</th><th>LiteLLM ID</th><th>Managed</th><th>Source model</th><th>Provider / backend</th><th>Recent checks</th><th>Response time</th><th>First token</th><th>Action</th></tr></thead><tbody>{sorted.map(row=>{
    const points=pointsById.get(row.id)??[];
    const isLocal=row.backend?.toLowerCase()==="mlx";
    // Averaged over the last (up to) 10 PASSED checks (see getDeployments) — a single sample is noisy; this
    // updates every health-check cycle. Sample count shown so a 1-check average doesn't read as equally reliable
    // as a 10-check one.
    const latencyCell=row.avgLatencyMs!=null?<><span className="mono">{duration(row.avgLatencyMs)}</span><div style={{fontSize:9.5,color:"var(--faint)"}}>{row.latencySampleCount} check{row.latencySampleCount===1?"":"s"}</div></>:<span className="settings-help">No data</span>;
    const firstTokenCell=row.avgFirstTokenMs!=null?<span className="mono">{duration(row.avgFirstTokenMs)}</span>:<span className="settings-help">—</span>;
    // A dedicated column, not a badge appended after the alias text — many rows share the exact same bold alias
    // (a lane name like "smart-summary" can be 5+ different underlying models), so a badge tucked into that line
    // was easy to miss entirely when scanning for one specific model. This column can't be missed per-row.
    const managedCell=row.managed?<span className="status-pill status-bad">RatLLM Managed</span>:<span className="status-pill status-neutral">Unmanaged</span>;
    return <tr key={row.id}><td className="mono"><Link href={`/models/${row.id}`}><strong>{row.litellmModelName}</strong>{isLocal&&<span className="status-pill status-info" style={{marginLeft:6}}>Local</span>}<br/><span>{row.providerModelId}</span></Link></td><td><CopyableId value={row.litellmDeploymentId} compact label="LiteLLM ID"/></td><td>{managedCell}</td><td>{row.modelName}</td><td>{row.providerName}{row.backend?<><br/><span className="mono">{row.backend}</span></>:null}</td><td>{points.length?<><UptimeBar items={points} label={`${row.litellmModelName} recent checks`} count={20} compact/><div style={{marginTop:4,fontSize:10,color:"var(--muted)"}}>{row.benchmarkRunCount} checks · {row.lastTestedAt?timeAgo(row.lastTestedAt):"Never"}</div></>:<span className="settings-help">No checks yet</span>}</td><td>{latencyCell}</td><td>{firstTokenCell}</td><td><DeploymentActions id={row.id} alias={row.litellmModelName} health={row.health} live={Boolean(row.litellmDeploymentId)}/></td></tr>;
  })}</tbody></table></div></section></PageShell>;
}

import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { UptimeBar } from "@/components/status-history-strip";
import { demoDeployments } from "@/server/demo-data";
import { getDeploymentSmokeHistory, getDeployments, withDemo, type SmokeHistoryPoint } from "@/server/queries";
import { DeploymentActions } from "./deployment-actions";
import { SyncButton } from "./sync-button";
export const dynamic="force-dynamic";
export default async function LiteLLMPage(){
  const rows=await withDemo(getDeployments,()=>demoDeployments);
  const history=await withDemo(() => getDeploymentSmokeHistory(20), () => new Map<string, SmokeHistoryPoint[]>());
  const managed=rows.filter(r=>r.managed).length;const local=rows.filter(r=>r.backend?.toLowerCase()==="mlx").length;
  return <PageShell title="LiteLLM" eyebrow="Live production-router inventory" actions={<SyncButton/>}><section className="system-strip"><div className="system-item"><div><small>CONNECTION</small><strong>LiteLLM Proxy</strong></div><StatusPill value={rows.length?"Healthy":"Not synced"}/></div><div className="system-item"><div><small>DEPLOYMENTS</small><strong>{rows.length} live</strong></div></div><div className="system-item"><div><small>LOCAL MLX</small><strong>{local} deployments</strong></div></div><div className="system-item"><div><small>OWNERSHIP</small><strong>{managed} Curator managed</strong></div></div></section><section className="panel"><div className="panel-header"><h3>Live deployment inventory</h3><span>{rows.length-managed} unmanaged deployments preserved as read-only</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Alias</th><th>Source model</th><th>Provider / backend</th><th>Host</th><th>Ownership</th><th>Health</th><th>Recent checks</th><th>Operational benchmark</th><th>Action</th></tr></thead><tbody>{rows.map(row=>{
    const points=(history.get(row.id)??[]).map(point=>({at:point.at,status:point.httpStatus===429?"RATE_LIMITED":point.status,detail:`HTTP ${point.httpStatus??"—"} · ${point.latencyMs??"—"}ms${point.error?` · ${point.error}`:""}`}));
    return <tr key={row.id}><td className="mono"><Link href={`/models/${row.id}`}><strong>{row.litellmModelName}</strong><br/><span>{row.providerModelId}</span></Link></td><td>{row.modelName}</td><td>{row.providerName}{row.backend?<><br/><span className="mono">{row.backend}</span></>:null}</td><td className="mono">{row.host??"—"}</td><td><span className={row.managed?"managed-badge":"unmanaged-badge"}>{row.managed?"Managed":"Unmanaged"}</span></td><td><StatusPill value={row.health}/></td><td>{points.length?<UptimeBar items={points} label={`${row.litellmModelName} recent checks`} count={20}/>:<span className="settings-help">No checks yet</span>}</td><td><StatusPill value={row.lastBenchmarkStatus ?? "NOT RUN"}/><br/><span>{row.benchmarkRunCount} runs · {row.lastTestedAt ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round((row.lastTestedAt.getTime() - new Date().getTime()) / 3600000), "hour") : "Never"}</span></td><td><DeploymentActions id={row.id} alias={row.litellmModelName} health={row.health} live={Boolean(row.litellmDeploymentId)}/></td></tr>;
  })}</tbody></table></div></section></PageShell>;
}

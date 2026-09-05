import { UptimeBar } from "@/components/status-history-strip";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { demoLanes } from "@/server/demo-data";
import { getLaneSnapshotHistory, type LaneSnapshotPoint } from "@/server/lanes/snapshots";
import { getLanes, withDemo } from "@/server/queries";
export const dynamic="force-dynamic";
export default async function LanesPage(){
  const [rows,history]=await Promise.all([withDemo(getLanes,()=>demoLanes),withDemo(() => getLaneSnapshotHistory(20), () => new Map<string, LaneSnapshotPoint[]>())]);
  return <PageShell title="Lanes" eyebrow="Stable application aliases"><div className="detail-grid">{rows.map(lane=>{
    const points=(history.get(lane.id)??[]).map(point=>({at:point.at,status:point.status,detail:`${point.healthy}/${point.total} healthy`}));
    return <section className="panel" key={lane.id}><div className="panel-header"><h3>{lane.slug.toUpperCase()}</h3><StatusPill value={lane.status}/></div><div className="panel-body"><div style={{display:"flex",alignItems:"baseline",gap:8}}><strong style={{fontFamily:"var(--font-mono)",fontSize:25}}>{lane.healthy}</strong><span style={{color:"var(--muted)",fontSize:10}}>healthy assigned deployments · {lane.total} assigned · minimum {lane.minimumHealthy}</span></div><div className={`bar ${lane.status!=="HEALTHY"?"warn":""}`} style={{marginTop:12}}><i style={{width:`${lane.minimumHealthy > 0 ? Math.min(100,lane.healthy/lane.minimumHealthy*100) : 100}%`}}/></div>{points.length>0&&<div style={{marginTop:12}}><UptimeBar items={points} label={`${lane.slug} health checks`} count={20}/></div>}<p style={{fontSize:10,color:"var(--muted)",marginBottom:0,marginTop:12}}>{lane.enabled?"Only non-excluded assignments are counted; inventory alone does not make an alias routable.":"This lane is disabled and excluded from coverage requirements."}</p></div></section>;
  })}</div></PageShell>;
}

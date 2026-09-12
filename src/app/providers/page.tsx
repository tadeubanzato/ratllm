import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { UptimeBar } from "@/components/status-history-strip";
import { timeAgo } from "@/lib/utils";
import { demoProviders } from "@/server/demo-data";
import { getProviders, getProviderSmokeHistory, getProviderSourceBreakdown, withDemo, type ProviderSourceBreakdown, type SmokeHistoryPoint } from "@/server/queries";
import { getIntegrationStatus, integrationStatusLabels, integrationStatusTone } from "@/server/providers/wiring";
import { VerifyProviderButton } from "./verify-button";
import { SkipProviderButton } from "./skip-button";
export const dynamic="force-dynamic";

function CoverageCell({row,breakdown}:{row:{knownCount:number;verifiedCount:number;modelCount:number;healthyCount:number};breakdown:ProviderSourceBreakdown[]}){
  return <div>
    <div className="mono" style={{fontSize:11,whiteSpace:"nowrap"}}>
      {row.knownCount} known <span style={{color:"var(--faint)"}}>→</span> {row.verifiedCount} verified <span style={{color:"var(--faint)"}}>→</span> {row.modelCount} live
      {row.modelCount>0&&row.healthyCount!==row.modelCount?` (${row.healthyCount} healthy)`:""}
    </div>
    {breakdown.length>0&&<details style={{marginTop:3}}>
      <summary style={{cursor:"pointer",fontSize:10,color:"var(--faint)"}}>sources</summary>
      <ul style={{margin:"4px 0 0",paddingLeft:14,fontSize:10,color:"var(--faint)"}}>
        {breakdown.map(item=><li key={item.source}>{item.source} ({item.tier}): {item.count}</li>)}
      </ul>
    </details>}
  </div>;
}

export default async function ProvidersPage(){
  const [rows,history,sourceBreakdown]=await Promise.all([
    withDemo(getProviders,()=>demoProviders),
    withDemo(()=>getProviderSmokeHistory(20),()=>new Map<string,SmokeHistoryPoint[]>()),
    withDemo(getProviderSourceBreakdown,()=>new Map<string,ProviderSourceBreakdown[]>()),
  ]);
  return <PageShell title="Providers" eyebrow={`${rows.length} integrations`}>
    <section className="panel"><div className="table-scroll"><table className="data-table">
      <thead><tr><th>Provider</th><th>Status</th><th>Coverage</th><th>Availability</th><th>Credential</th><th>Integration</th><th>Last discovery</th><th>Action</th></tr></thead>
      <tbody>{rows.map(row=>{
        const points=(history.get(row.id)??[]).map(item=>({at:item.at,status:item.httpStatus===429?"rate_limited":item.status,detail:`HTTP ${item.httpStatus??"—"}${item.error?` · ${item.error}`:""}`}));
        const integration=getIntegrationStatus(row.slug,{configured:row.credentialConfigured,verified:row.credentialVerified===true},row.modelCount>0);
        return <tr key={row.id}>
          <td><Link href={`/providers/${row.id}`}><strong>{row.name}</strong><br/><span className="mono">{row.slug}</span></Link></td>
          <td><StatusPill value={row.enabled===false?"SKIPPED":row.status}/></td>
          <td><CoverageCell row={row} breakdown={sourceBreakdown.get(row.id)??[]}/></td>
          <td><UptimeBar items={points} label={`${row.name} availability checks`} count={20} compact/></td>
          <td><StatusPill value={row.credentialVerified?"Verified":row.credentialConfigured?"Configured · unverified":"Missing"}/></td>
          <td><span className={`status-pill status-${integrationStatusTone[integration]}`}>{integrationStatusLabels[integration]}</span></td>
          <td>{row.lastDiscoveryAt?timeAgo(row.lastDiscoveryAt):"Manual"}</td>
          <td style={{display:"flex",gap:6}}><VerifyProviderButton providerId={row.id} disabled={!row.credentialConfigured||row.enabled===false}/><SkipProviderButton providerId={row.id} enabled={row.enabled!==false}/></td>
        </tr>;
      })}</tbody>
    </table></div></section>
  </PageShell>;
}

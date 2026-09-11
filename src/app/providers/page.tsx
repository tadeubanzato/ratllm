import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { UptimeBar } from "@/components/status-history-strip";
import { timeAgo } from "@/lib/utils";
import { demoProviders } from "@/server/demo-data";
import { getProviders, getProviderSmokeHistory, withDemo, type SmokeHistoryPoint } from "@/server/queries";
import { VerifyProviderButton } from "./verify-button";
import { SkipProviderButton } from "./skip-button";
export const dynamic="force-dynamic";

export default async function ProvidersPage(){
  const [rows,history]=await Promise.all([withDemo(getProviders,()=>demoProviders),withDemo(()=>getProviderSmokeHistory(20),()=>new Map<string,SmokeHistoryPoint[]>())]);
  return <PageShell title="Providers" eyebrow={`${rows.length} integrations`}>
    <section className="panel"><div className="table-scroll"><table className="data-table">
      <thead><tr><th>Provider</th><th>Status</th><th>Availability</th><th>Models</th><th>Healthy</th><th>Credential</th><th>Adapter</th><th>Last discovery</th><th>Action</th></tr></thead>
      <tbody>{rows.map(row=>{
        const points=(history.get(row.id)??[]).map(item=>({at:item.at,status:item.httpStatus===429?"rate_limited":item.status,detail:`HTTP ${item.httpStatus??"—"}${item.error?` · ${item.error}`:""}`}));
        return <tr key={row.id}>
          <td><Link href={`/providers/${row.id}`}><strong>{row.name}</strong><br/><span className="mono">{row.slug}</span></Link></td>
          <td><StatusPill value={row.enabled===false?"SKIPPED":row.status}/></td>
          <td><UptimeBar items={points} label={`${row.name} availability checks`} count={20} compact/></td>
          <td className="mono">{row.modelCount}</td>
          <td className="mono">{row.healthyCount}</td>
          <td><StatusPill value={row.credentialVerified?"Verified":row.credentialConfigured?"Configured · unverified":"Missing"}/></td>
          <td>{row.adapterCapability.toLowerCase()}</td>
          <td>{row.lastDiscoveryAt?timeAgo(row.lastDiscoveryAt):"Manual"}</td>
          <td style={{display:"flex",gap:6}}><VerifyProviderButton providerId={row.id} disabled={!row.credentialConfigured||row.enabled===false}/><SkipProviderButton providerId={row.id} enabled={row.enabled!==false}/></td>
        </tr>;
      })}</tbody>
    </table></div></section>
  </PageShell>;
}

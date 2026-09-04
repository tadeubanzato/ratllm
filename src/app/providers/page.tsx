import Link from "next/link";import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { timeAgo } from "@/lib/utils";
import { demoProviders } from "@/server/demo-data";
import { getProviders, withDemo } from "@/server/queries";
import { VerifyProviderButton } from "./verify-button";
export const dynamic="force-dynamic";
export default async function ProvidersPage(){const rows=await withDemo(getProviders,()=>demoProviders);return <PageShell title="Providers" eyebrow={`${rows.length} integrations`}><section className="panel"><table className="data-table"><thead><tr><th>Provider</th><th>Status</th><th>Models</th><th>Healthy</th><th>Credential</th><th>Adapter</th><th>Last discovery</th><th>Action</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><Link href={`/providers/${row.id}`}><strong>{row.name}</strong><br/><span className="mono">{row.slug}</span></Link></td><td><StatusPill value={row.status}/></td><td className="mono">{row.modelCount}</td><td className="mono">{row.healthyCount}</td><td><StatusPill value={row.credentialVerified?"Verified":row.credentialConfigured?"Configured · unverified":"Missing"}/></td><td>{row.adapterCapability.toLowerCase()}</td><td>{row.lastDiscoveryAt?timeAgo(row.lastDiscoveryAt):"Manual"}</td><td><VerifyProviderButton providerId={row.id} disabled={!row.credentialConfigured}/></td></tr>)}</tbody></table></section></PageShell>}

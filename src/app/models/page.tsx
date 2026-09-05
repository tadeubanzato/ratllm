import { UptimeBar } from "@/components/status-history-strip";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { timeAgo } from "@/lib/utils";
import { getCandidateCheckHistory, getModelCandidates, withDemo, type CandidateCheckPoint } from "@/server/queries";
import { getCandidateProviderPortal } from "@/server/providers/portals";
import { DiscoveryButton } from "./discovery-button";

type CandidateRow=Awaited<ReturnType<typeof getModelCandidates>>[number];
function availabilityFor(row:CandidateRow){const evidence=row.evidence;const lastStatus=String(evidence.lastStatus??"").toLowerCase();const status=lastStatus==="provider_unresolved"?"PROVIDER_UNRESOLVED":lastStatus==="provider_not_configured"?"VERIFIER_NOT_CONFIGURED":lastStatus==="auth_error"?"AUTH_ERROR":!row.providerId?"PROVIDER_UNRESOLVED":!row.credentialConfigured?"CREDENTIAL_MISSING":!row.credentialVerified?"CREDENTIAL_UNVERIFIED":lastStatus==="available"||lastStatus==="passed"?"AVAILABLE":lastStatus==="rate_limited"?"RATE_LIMITED":lastStatus==="unavailable"||lastStatus==="failed"?"UNAVAILABLE":"QUEUED";return{status,httpStatus:typeof evidence.lastHttpStatus==="number"?evidence.lastHttpStatus:null,lastTestedAt:typeof evidence.testedAt==="string"?new Date(evidence.testedAt):null,nextCheckAt:typeof evidence.nextCheckAt==="string"?new Date(evidence.nextCheckAt):null,requiredAction:typeof evidence.requiredAction==="string"?evidence.requiredAction:null};}

function candidateHistoryItems(points: CandidateCheckPoint[]) {
  return points.map(point => ({at: point.at, status: point.httpStatus === 429 ? "RATE_LIMITED" : point.status, detail: `HTTP ${point.httpStatus ?? "—"}${point.error ? ` · ${point.error}` : ""}`}));
}

export const dynamic="force-dynamic";
export default async function ModelsPage(){
  const [candidates,candidateHistory]=await Promise.all([getModelCandidates(),withDemo(() => getCandidateCheckHistory(20), () => new Map<string, CandidateCheckPoint[]>())]);
  return <PageShell title="Discovered Models" eyebrow={`${candidates.length} discovery observations · live inventory lives under LiteLLM`} actions={<DiscoveryButton/>}><section className="panel"><div className="panel-header"><h3>Discovered free-model candidates</h3><span>Availability checks run automatically on schedule (Settings → Automation → Candidate verification)</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Candidate</th><th>Provider / credential</th><th>Source</th><th>Free evidence</th><th>Context</th><th>Availability</th><th>Last tested</th></tr></thead><tbody>{candidates.length?candidates.map(row=>{
    const portal=getCandidateProviderPortal(row.source,row.providerName,row.modelRef);
    const availability=availabilityFor(row);
    const points=candidateHistoryItems(candidateHistory.get(row.id)??[]);
    return <tr key={row.id}><td><strong>{row.displayName}</strong><br/><span className="mono">{row.modelRef}</span></td><td>{row.providerName??"Unresolved"}{portal?<><br/><a href={portal.url} target="_blank" rel="noopener noreferrer">{portal.label} ↗</a><br/><StatusPill value={row.credentialVerified?"Credential verified":row.credentialConfigured?"Credential unverified":"Credential missing"}/></>:<><br/><span style={{color:"var(--faint)",fontSize:10}}>No verified provider portal</span></>}</td><td><a href={row.sourceUrl??"#"} target="_blank" rel="noopener noreferrer">{row.source}</a></td><td><StatusPill value={row.verifiedFree?row.freeType:"UNVERIFIED"}/></td><td className="mono">{row.contextWindow?.toLocaleString()??"—"}</td><td><UptimeBar items={points} label={`${row.displayName} availability checks`} count={20} compact/>{availability.requiredAction&&<div style={{marginTop:4,fontSize:10,color:"var(--muted)"}}>{availability.requiredAction.replaceAll("_"," ")}</div>}{availability.status==="RATE_LIMITED"&&availability.nextCheckAt&&<div style={{marginTop:2,fontSize:10,color:"var(--muted)"}}>Retries {timeAgo(availability.nextCheckAt)}</div>}</td><td>{availability.lastTestedAt?timeAgo(availability.lastTestedAt):availability.status==="QUEUED"?"Awaiting scheduled test":"—"}</td></tr>;
  }):<tr><td colSpan={7}>No candidates stored. Run discovery to query the live sources.</td></tr>}</tbody></table></div></section></PageShell>;
}

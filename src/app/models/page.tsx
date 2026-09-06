import { UptimeBar } from "@/components/status-history-strip";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { timeAgo } from "@/lib/utils";
import { getCandidateCheckHistory, getModelCandidates, withDemo, type CandidateCheckPoint } from "@/server/queries";
import { sourceRegistry } from "@/server/discovery/registry";
import { DiscoveryButton } from "./discovery-button";
import { VerifyButton } from "./verify-button";
import { AddToLiteLLMButton } from "./connect-button";

const DISPLAY_LIMIT = 300;
const tierRank: Record<string, number> = Object.fromEntries(sourceRegistry.map(source => [source.id, source.tier === "A1" ? 0 : source.tier === "A2" ? 1 : source.tier === "B" ? 2 : 3]));

type CandidateRow=Awaited<ReturnType<typeof getModelCandidates>>[number];
function availabilityFor(row:CandidateRow){const evidence=row.evidence;const lastStatus=String(evidence.lastStatus??"").toLowerCase();const status=lastStatus==="provider_unresolved"?"PROVIDER_UNRESOLVED":lastStatus==="provider_not_configured"?"VERIFIER_NOT_CONFIGURED":lastStatus==="auth_error"?"AUTH_ERROR":!row.providerId?"PROVIDER_UNRESOLVED":!row.credentialConfigured?"CREDENTIAL_MISSING":!row.credentialVerified?"CREDENTIAL_UNVERIFIED":lastStatus==="available"||lastStatus==="passed"?"AVAILABLE":lastStatus==="rate_limited"?"RATE_LIMITED":lastStatus==="unavailable"||lastStatus==="failed"?"UNAVAILABLE":"QUEUED";return{status,httpStatus:typeof evidence.lastHttpStatus==="number"?evidence.lastHttpStatus:null,lastTestedAt:typeof evidence.testedAt==="string"?new Date(evidence.testedAt):null,nextCheckAt:typeof evidence.nextCheckAt==="string"?new Date(evidence.nextCheckAt):null,requiredAction:typeof evidence.requiredAction==="string"?evidence.requiredAction:null};}

function candidateHistoryItems(points: CandidateCheckPoint[]) {
  return points.map(point => ({at: point.at, status: point.httpStatus === 429 ? "RATE_LIMITED" : point.status, detail: `HTTP ${point.httpStatus ?? "—"}${point.error ? ` · ${point.error}` : ""}`}));
}

export const dynamic="force-dynamic";
export default async function ModelsPage(){
  const [allCandidates,candidateHistory]=await Promise.all([getModelCandidates(),withDemo(() => getCandidateCheckHistory(20), () => new Map<string, CandidateCheckPoint[]>())]);
  const sorted=[...allCandidates].sort((a,b)=>{
    if(a.credentialVerified!==b.credentialVerified)return a.credentialVerified?-1:1;
    if(a.verifiedFree!==b.verifiedFree)return a.verifiedFree?-1:1;
    const ta=tierRank[a.source]??4,tb=tierRank[b.source]??4;
    if(ta!==tb)return ta-tb;
    return a.displayName.localeCompare(b.displayName);
  });
  const candidates=sorted.slice(0,DISPLAY_LIMIT);
  const truncated=allCandidates.length>DISPLAY_LIMIT;
  return <PageShell title="Discovered Models" eyebrow={truncated?`Showing top ${DISPLAY_LIMIT} of ${allCandidates.length} discovery observations, models you can already test first · manage credentials under Settings → Providers`:`${allCandidates.length} discovery observations · manage credentials under Settings → Providers`} actions={<div style={{display:"flex",alignItems:"center",gap:12}}><VerifyButton/><DiscoveryButton/></div>}><section className="panel"><div className="panel-header"><h3>Discovered free-model candidates</h3><span>Availability checks run automatically on schedule (Settings → Automation → Candidate verification)</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Candidate</th><th>Provider / credential</th><th>Free evidence</th><th>Context</th><th>Availability</th><th>Last tested</th><th>LiteLLM</th></tr></thead><tbody>{candidates.length?candidates.map(row=>{
    const availability=availabilityFor(row);
    const points=candidateHistoryItems(candidateHistory.get(row.id)??[]);
    const inLiteLLM=Boolean(row.liteLLMDeploymentId);
    const canAdd=!inLiteLLM&&row.credentialVerified&&Boolean(row.providerId);
    return <tr key={row.id}><td><strong>{row.displayName}</strong><br/><span className="mono">{row.modelRef}</span></td><td>{row.providerName??"Unresolved"}<br/><StatusPill value={row.credentialVerified?"Credential verified":row.credentialConfigured?"Credential unverified":"Credential missing"}/></td><td><StatusPill value={row.verifiedFree?row.freeType:"UNVERIFIED"}/></td><td className="mono">{row.contextWindow?.toLocaleString()??"—"}</td><td><UptimeBar items={points} label={`${row.displayName} availability checks`} count={20} compact/>{availability.requiredAction&&<div style={{marginTop:4,fontSize:10,color:"var(--muted)"}}>{availability.requiredAction.replaceAll("_"," ")}</div>}{availability.status==="RATE_LIMITED"&&availability.nextCheckAt&&<div style={{marginTop:2,fontSize:10,color:"var(--muted)"}}>Retries {timeAgo(availability.nextCheckAt)}</div>}</td><td>{availability.lastTestedAt?timeAgo(availability.lastTestedAt):availability.status==="QUEUED"?"Awaiting scheduled test":"—"}</td><td>{inLiteLLM?<button className="button small success" type="button" disabled>Added</button>:canAdd?<AddToLiteLLMButton candidateId={row.id}/>:null}</td></tr>;
  }):<tr><td colSpan={7}>No candidates stored. Run discovery to query the live sources.</td></tr>}</tbody></table></div></section></PageShell>;
}

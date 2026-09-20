import Link from "next/link";
import { httpPromptDetail, UptimeBar, availabilityPercent } from "@/components/status-history-strip";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { Tooltip } from "@/components/tooltip";
import { timeAgo } from "@/lib/utils";
import { getCandidateCheckHistory, getCandidateLastPassed, getModelCandidates, withDemo, type CandidateCheckPoint } from "@/server/queries";
import { sourceRegistry } from "@/server/discovery/registry";
import { newlyDiscoveredIds } from "@/server/discovery/new-candidates";
import { DiscoveryButton } from "./discovery-button";
import { VerifyButton } from "./verify-button";
import { AddToLiteLLMButton } from "./connect-button";

const DISPLAY_LIMIT = 300;
const tierRank: Record<string, number> = Object.fromEntries(sourceRegistry.map(source => [source.id, source.tier === "A1" ? 0 : source.tier === "A2" ? 1 : source.tier === "B" ? 2 : 3]));

/** Column proportions. The table is fixed-layout so a long model id can't stretch its column and squeeze the rest;
 *  the id wraps inside its own cell instead. Percentages sum to 100. */
const COLUMNS: Array<{ label: string; width: string }> = [
  { label: "Candidate", width: "31%" },
  { label: "Provider", width: "16%" },
  { label: "Free tier", width: "11%" },
  { label: "Availability", width: "18%" },
  { label: "Last passed", width: "10%" },
  { label: "LiteLLM", width: "14%" },
];

type CandidateRow=Awaited<ReturnType<typeof getModelCandidates>>[number];

function candidateHistoryItems(points: CandidateCheckPoint[]) {
  return points.map(point => ({at: point.at, status: point.httpStatus === 429 ? "RATE_LIMITED" : point.status, detail: httpPromptDetail(point.httpStatus, point.status === "available", point.error)}));
}

/** The one thing someone can do about a candidate that can't be added yet, as a link to where it's fixed. Every other
 *  reason a candidate isn't promotable (unresolved provider, a non-chat model, "hasn't passed a check yet", …) is a
 *  fact about the pipeline rather than something to act on here — it stays on the candidate row in the database and
 *  in the promotion logic, and the page says nothing rather than printing an internal status nobody can use. */
function promotionAction(row: CandidateRow) {
  if (!row.providerId || !row.promotableReason) return null;
  if (row.promotableReason === "Credential not verified") return <Link className="settings-link-button" style={{fontSize:10}} href={`/providers/${row.providerId}`}>Verify credential →</Link>;
  if (row.promotableReason === "No known endpoint for this provider") return <Link className="settings-link-button" style={{fontSize:10}} href={`/providers/${row.providerId}`}>Set base URL →</Link>;
  return null;
}

/** What happened to this candidate in LiteLLM, as one short pill with the explanation on hover. A deployment row
 *  outlives removal on purpose (history/health are kept), and REMOVED must never hide the re-add path
 *  (docs/FREE-MODEL-LIFECYCLE.md §3) — so this sits beside the Add button instead of replacing it. */
function lifecyclePill(row: CandidateRow) {
  if (row.liteLLMLifecycle === "DEACTIVATED") return <Tooltip label="Turned off in LiteLLM. Reactivate it from the LiteLLM page — it is not re-added from here."><span className="status-pill status-pill-sm status-warn">Deactivated</span></Tooltip>;
  if (row.liteLLMLifecycle !== "REMOVED") return null;
  if (!row.liteLLMRemovedReason) return <Tooltip label="This model was deleted from LiteLLM by hand."><span className="status-pill status-pill-sm status-neutral">Deleted</span></Tooltip>;
  return row.liteLLMNeedsReview
    ? <Tooltip label="Automation removed this after repeated failures, and it has now happened too many times to retry on its own. Add it back manually once you trust it again."><span className="status-pill status-pill-sm status-bad">Needs review</span></Tooltip>
    : <Tooltip label="Automation removed this after repeated failures. It stays under watch and is re-added automatically once it passes its checks again."><span className="status-pill status-pill-sm status-warn">Will retry</span></Tooltip>;
}

export const dynamic="force-dynamic";
export default async function ModelsPage(){
  const [allCandidates,candidateHistory,lastPassed]=await Promise.all([
    getModelCandidates(),
    withDemo(() => getCandidateCheckHistory(20), () => new Map<string, CandidateCheckPoint[]>()),
    withDemo(() => getCandidateLastPassed(), () => new Map<string, Date>()),
  ]);
  const newIds=newlyDiscoveredIds(allCandidates);
  const availabilityById=new Map(allCandidates.map(row=>[row.id,availabilityPercent(candidateHistoryItems(candidateHistory.get(row.id)??[]),12)]));
  const sorted=[...allCandidates].sort((a,b)=>{
    // Highest availability first; candidates with no check history yet sort last regardless of how they compare otherwise.
    const pa=availabilityById.get(a.id)??null,pb=availabilityById.get(b.id)??null;
    if(pa!==pb){if(pa===null)return 1;if(pb===null)return -1;if(pa!==pb)return pb-pa;}
    if(a.credentialVerified!==b.credentialVerified)return a.credentialVerified?-1:1;
    if(a.verifiedFree!==b.verifiedFree)return a.verifiedFree?-1:1;
    const ta=tierRank[a.source]??4,tb=tierRank[b.source]??4;
    if(ta!==tb)return ta-tb;
    return a.displayName.localeCompare(b.displayName);
  });
  const candidates=sorted.slice(0,DISPLAY_LIMIT);
  const truncated=allCandidates.length>DISPLAY_LIMIT;
  const wrap={whiteSpace:"normal" as const};
  return <PageShell title="Discovered Models" eyebrow={truncated?`Showing top ${DISPLAY_LIMIT} of ${allCandidates.length} discovered models · manage credentials under Settings → Providers`:`${allCandidates.length} discovered models · manage credentials under Settings → Providers`} actions={<div style={{display:"flex",alignItems:"center",gap:12}}><VerifyButton/><DiscoveryButton/></div>}>
    <section className="panel">
      <div className="panel-header"><h3>Discovered free-model candidates</h3><span style={{fontSize:11,color:"var(--muted)"}}>Availability checks run automatically on schedule (Settings → Automation → Candidate verification)</span></div>
      <div className="table-scroll">
        <table className="data-table" style={{tableLayout:"fixed",minWidth:980}}>
          <colgroup>{COLUMNS.map(column=><col key={column.label} style={{width:column.width}}/>)}</colgroup>
          <thead><tr>{COLUMNS.map(column=><th key={column.label}>{column.label}</th>)}</tr></thead>
          <tbody>{candidates.length?candidates.map(row=>{
            const points=candidateHistoryItems(candidateHistory.get(row.id)??[]);
            const passedAt=lastPassed.get(row.id)??null;
            const lifecycle=lifecyclePill(row);
            const action=!row.liteLLMDeploymentId&&row.liteLLMLifecycle!=="DEACTIVATED"?(row.promotable?<AddToLiteLLMButton candidateId={row.id}/>:promotionAction(row)):null;
            return <tr key={row.id}>
              <td style={wrap}>
                <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                  {newIds.has(row.id)?<Tooltip label={`New from discovery — first found ${timeAgo(row.firstSeenAt)}. Shown for 24 hours, and only for models not already in LiteLLM.`}><span className="status-pill status-pill-xs status-info" style={{marginTop:2}}>New</span></Tooltip>:null}
                  <div style={{minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                      <strong style={{overflowWrap:"anywhere"}}>{row.displayName}</strong>
                      {/* R = RatLLM created and manages this deployment; L = it is live in LiteLLM. They are independent —
                          a model added to LiteLLM by hand is L but not R, and R without L means RatLLM owns the record
                          while the deployment is not currently serving. */}
                      {row.liteLLMManaged?<Tooltip label="Managed by RatLLM — this deployment was created here, so automation may update or remove it."><span className="status-pill status-pill-xs status-pill-outline" style={{color:"var(--accent)"}}>R</span></Tooltip>:null}
                      {row.liteLLMDeploymentId?<Tooltip label="Already added to LiteLLM — this model is live in the LiteLLM inventory."><span className="status-pill status-pill-xs status-good">L</span></Tooltip>:null}
                    </div>
                    <div className="mono" style={{fontSize:9,color:"var(--faint)",overflowWrap:"anywhere"}}>{row.modelRef}</div>
                  </div>
                </div>
              </td>
              <td style={wrap}>{row.providerName??"Unresolved"}<br/><StatusPill value={!row.credentialRequired?"No credential needed":row.credentialVerified?"Credential verified":row.credentialConfigured?"Credential unverified":"Credential missing"}/></td>
              <td><span className="mono" style={{fontSize:9.5}}>{row.contextWindow?.toLocaleString()??"—"} ctx</span><br/><StatusPill value={row.verifiedFree?row.freeType:"UNVERIFIED"}/></td>
              <td><UptimeBar items={points} label={`${row.displayName} availability checks`} count={12} compact/></td>
              <td>{passedAt?<span title={passedAt.toLocaleString()}>{timeAgo(passedAt)}</span>:<span style={{color:"var(--faint)"}}>—</span>}</td>
              <td style={wrap}>
                {lifecycle||action?<div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>{lifecycle}{action}</div>:<span style={{color:"var(--faint)"}}>—</span>}
              </td>
            </tr>;
          }):<tr><td colSpan={COLUMNS.length}>No candidates stored. Run discovery to query the live sources.</td></tr>}</tbody>
        </table>
      </div>
    </section>
  </PageShell>;
}

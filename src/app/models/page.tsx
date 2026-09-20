import Link from "next/link";
import { httpPromptDetail, UptimeBar } from "@/components/status-history-strip";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { Tooltip } from "@/components/tooltip";
import { timeAgo } from "@/lib/utils";
import { CANDIDATE_VIEWS, DEFAULT_PAGE_SIZE, getCandidateCheckHistory, getCandidatePage, withDemo, type CandidateRow, type CandidateCheckPoint, type CandidateView } from "@/server/queries";
import { FREE_KIND_LABELS, PROMOTION_PASSES } from "@/server/discovery/verification-policy";
import { DiscoveryButton } from "./discovery-button";
import { VerifyButton } from "./verify-button";
import { AddToLiteLLMButton } from "./connect-button";

/** Column proportions. The table is fixed-layout so a long model id can't stretch its column and squeeze the rest;
 *  the id wraps inside its own cell instead. Percentages sum to 100. */
const COLUMNS: Array<{ label: string; width: string }> = [
  { label: "Candidate", width: "30%" },
  { label: "Provider", width: "15%" },
  { label: "Free", width: "12%" },
  { label: "Availability", width: "17%" },
  { label: "Last passed", width: "9%" },
  { label: "LiteLLM", width: "17%" },
];

function candidateHistoryItems(points: CandidateCheckPoint[]) {
  return points.map(point => ({at: point.at, status: point.httpStatus === 429 ? "RATE_LIMITED" : point.status, detail: httpPromptDetail(point.httpStatus, point.status === "available", point.error)}));
}

/** The one thing someone can do about a candidate that can't be tested or added yet, as a link to where it is fixed. Every other
 *  reason (no provider, not a chat model, still proving itself, …) is a fact about the pipeline rather than something to act on
 *  here — it stays on the candidate in the database and the page says nothing rather than printing an internal status. */
function setupAction(row: CandidateRow) {
  if (!row.providerId) return null;
  const style = { fontSize: 10 };
  if (row.checkBlocker === "CREDENTIAL_MISSING") return <Link className="settings-link-button" style={style} href={`/providers/${row.providerId}`}>Add credential →</Link>;
  if (row.checkBlocker === "CREDENTIAL_UNVERIFIED") return <Link className="settings-link-button" style={style} href={`/providers/${row.providerId}`}>Verify credential →</Link>;
  if (row.checkBlocker === "NO_ENDPOINT") return <Link className="settings-link-button" style={style} href={`/providers/${row.providerId}`}>Set base URL →</Link>;
  return null;
}

/** What happened to this candidate in LiteLLM, as one short pill with the explanation on hover. A deployment row outlives removal
 *  on purpose (history and health are kept), and REMOVED must never hide the re-add path (docs/FREE-MODEL-LIFECYCLE.md §3), so this
 *  sits beside the Add button instead of replacing it. */
function lifecyclePill(row: CandidateRow) {
  if (row.liteLLMLifecycle === "DEACTIVATED") return <Tooltip label="Turned off in LiteLLM. Reactivate it from the LiteLLM page — it is not re-added from here."><span className="status-pill status-pill-sm status-warn">Deactivated</span></Tooltip>;
  if (row.liteLLMLifecycle !== "REMOVED") return null;
  if (!row.liteLLMRemovedReason) return <Tooltip label="This model was deleted from LiteLLM by hand."><span className="status-pill status-pill-sm status-neutral">Deleted</span></Tooltip>;
  return row.liteLLMNeedsReview
    ? <Tooltip label="Automation removed this after repeated failures, and it has now happened too many times to retry on its own. Add it back manually once you trust it again."><span className="status-pill status-pill-sm status-bad">Needs review</span></Tooltip>
    : <Tooltip label="Automation removed this after repeated failures. It stays under watch and is re-added automatically once it passes its checks again."><span className="status-pill status-pill-sm status-warn">Will retry</span></Tooltip>;
}

/** The provider's published free offer, in the source's own words, for the "Free" column's hover. Nothing here is parsed or paraphrased. */
function offerTooltip(row: CandidateRow) {
  const offer = row.offer;
  if (!offer) return `${FREE_KIND_LABELS[row.freeKind]}. No source has published this provider's free offer.`;
  const parts = [offer.freeTierText && `Free tier: ${offer.freeTierText}`, offer.rateLimitsText && `Limits: ${offer.rateLimitsText}`, offer.expiresAt && `Expires: ${offer.expiresAt}`,
    offer.cardRequired !== null && `Card required: ${offer.cardRequired ? "yes" : "no"}`, offer.commercialOk !== null && `Commercial use: ${offer.commercialOk ? "ok" : "not allowed"}`,
    `Source: ${offer.source}${offer.sourceLastVerified ? `, verified ${offer.sourceLastVerified}` : ""}`].filter(Boolean);
  return parts.join(" · ");
}

const queryString = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export const dynamic="force-dynamic";
export default async function ModelsPage({ searchParams }: { searchParams: SearchParams }){
  const params = await searchParams;
  const view = (CANDIDATE_VIEWS.some(item => item.id === first(params.view)) ? first(params.view) : "all") as CandidateView;
  const q = first(params.q)?.slice(0, 100);
  const provider = first(params.provider)?.slice(0, 80);
  const requestedPage = Math.max(1, Number.parseInt(first(params.page) ?? "1", 10) || 1);

  const result = await getCandidatePage({ view, q, provider, page: requestedPage, pageSize: DEFAULT_PAGE_SIZE });
  const history = await withDemo(() => getCandidateCheckHistory(result.rows.map(row => row.id), 12), () => new Map<string, CandidateCheckPoint[]>());
  const filters = { view: view === "all" ? undefined : view, q, provider };
  const link = (over: Record<string, string | undefined>) => `/models${queryString({ ...filters, ...over })}`;
  const wrap = { whiteSpace: "normal" as const };
  const from = result.total ? (result.page - 1) * result.pageSize + 1 : 0;
  const to = Math.min(result.total, result.page * result.pageSize);

  return <PageShell title="Discovered Models" eyebrow={`${result.counts.all.toLocaleString()} discovered models · manage credentials under Settings → Providers`} actions={<div style={{display:"flex",alignItems:"center",gap:12}}><VerifyButton/><DiscoveryButton/></div>}>
    <section className="panel">
      <div className="panel-header" style={{height:"auto",padding:"10px 15px",flexWrap:"wrap",gap:10}}>
        <nav aria-label="Filter models" style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {CANDIDATE_VIEWS.map(item => <Tooltip key={item.id} label={item.hint}><Link href={link({ view: item.id === "all" ? undefined : item.id, page: undefined })} className={`status-pill status-pill-sm ${view === item.id ? "status-info" : "status-neutral"}`} aria-current={view === item.id ? "page" : undefined} style={{fontSize:10,padding:"3px 10px",textDecoration:"none"}}>{item.label} · {result.counts[item.id].toLocaleString()}</Link></Tooltip>)}
        </nav>
        <form method="get" action="/models" style={{display:"flex",gap:6,alignItems:"center"}}>
          {filters.view ? <input type="hidden" name="view" value={filters.view}/> : null}
          {provider ? <input type="hidden" name="provider" value={provider}/> : null}
          <input name="q" defaultValue={q ?? ""} placeholder="Search models or providers" aria-label="Search models or providers" style={{fontSize:11,padding:"5px 9px",border:"1px solid var(--border-strong)",borderRadius:6,background:"var(--surface)",color:"var(--text)",minWidth:210}}/>
          <button type="submit" className="settings-link-button" style={{fontSize:11}}>Search</button>
          {q || provider ? <Link href={link({ q: undefined, provider: undefined, page: undefined })} style={{fontSize:11,color:"var(--muted)"}}>Clear{provider ? ` (provider: ${provider})` : ""}</Link> : null}
        </form>
      </div>
      <div className="table-scroll">
        <table className="data-table" style={{tableLayout:"fixed",minWidth:1000}}>
          <colgroup>{COLUMNS.map(column=><col key={column.label} style={{width:column.width}}/>)}</colgroup>
          <thead><tr>{COLUMNS.map(column=><th key={column.label}>{column.label}</th>)}</tr></thead>
          <tbody>{result.rows.length?result.rows.map(row=>{
            const points=candidateHistoryItems(history.get(row.id)??[]);
            const lifecycle=lifecyclePill(row);
            const live=Boolean(row.liteLLMDeploymentId);
            const action=!live&&row.liteLLMLifecycle!=="DEACTIVATED"?(row.promotable?<AddToLiteLLMButton candidateId={row.id}/>:setupAction(row)):null;
            const toGo=!live&&row.checkBlocker===null&&row.consecutivePasses>0&&row.consecutivePasses<PROMOTION_PASSES;
            return <tr key={row.id}>
              <td style={wrap}>
                <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                  {row.isNew?<Tooltip label={`New from discovery — first found ${timeAgo(row.firstSeenAt)}. Shown for 24 hours, and only for models not already in LiteLLM.`}><span className="status-pill status-pill-xs status-info" style={{marginTop:2}}>New</span></Tooltip>:null}
                  <div style={{minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                      <strong style={{overflowWrap:"anywhere"}}>{row.displayName}</strong>
                      {/* R = RatLLM created and manages this deployment; L = it is live in LiteLLM. They are independent — a model
                          added to LiteLLM by hand is L but not R, and R without L means RatLLM owns the record while the
                          deployment is not currently serving. */}
                      {row.liteLLMManaged?<Tooltip label="Managed by RatLLM — this deployment was created here, so automation may update or remove it."><span className="status-pill status-pill-xs status-pill-outline" style={{color:"var(--accent)"}}>R</span></Tooltip>:null}
                      {live?<Tooltip label="Already added to LiteLLM — this model is live in the LiteLLM inventory."><span className="status-pill status-pill-xs status-good">L</span></Tooltip>:null}
                    </div>
                    <div className="mono" style={{fontSize:9,color:"var(--faint)",overflowWrap:"anywhere"}}>{row.modelRef}</div>
                    {row.alsoAt>0?<Tooltip label="Other providers list a model with the same name. They are separate candidates, tested and added independently — the name match ignores organisation prefixes, so check that it is the same model."><Link href={`/models${queryString({ q: row.modelRef.split("/").at(-1) })}`} style={{fontSize:9,color:"var(--muted)"}}>also listed by {row.alsoAt} other provider{row.alsoAt===1?"":"s"}</Link></Tooltip>:null}
                  </div>
                </div>
              </td>
              <td style={wrap}>{row.providerName?<Link href={link({ provider: row.providerSlug ?? undefined, page: undefined })} style={{color:"inherit"}}>{row.providerName}</Link>:"Unresolved"}<br/><StatusPill value={!row.credentialRequired?"No credential needed":row.credentialVerified?"Credential verified":row.credentialConfigured?"Credential unverified":"Credential missing"}/></td>
              <td><span className="mono" style={{fontSize:9.5}}>{row.contextWindow?.toLocaleString()??"—"} ctx</span><br/><Tooltip label={offerTooltip(row)}><span className={`status-pill status-pill-sm ${row.freeKind==="FOREVER"?"status-good":row.freeKind==="UNKNOWN"||row.freeKind==="PAID"?"status-neutral":"status-warn"}`}>{FREE_KIND_LABELS[row.freeKind]}</span></Tooltip></td>
              <td>
                <UptimeBar items={points} label={`${row.displayName} availability checks`} count={12} compact/>
                {toGo?<div style={{fontSize:9,color:"var(--faint)",marginTop:2}}>{row.consecutivePasses} of {PROMOTION_PASSES} passes in a row</div>:null}
              </td>
              <td>{row.lastPassedAt?<span title={row.lastPassedAt.toLocaleString()}>{timeAgo(row.lastPassedAt)}</span>:<span style={{color:"var(--faint)"}}>—</span>}</td>
              <td style={wrap}>
                {live&&row.addedAt?<Tooltip label={`Added to LiteLLM ${row.addedAt.toLocaleString()}${row.addedBy?` · by ${row.addedBy==="auto"?"RatLLM automatically":"you"}`:""}`}><span className="status-pill status-pill-sm status-good">Added {row.addedAt.toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span></Tooltip>:null}
                {lifecycle||action?<div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>{lifecycle}{action}</div>:(!live?<span style={{color:"var(--faint)"}}>—</span>:null)}
              </td>
            </tr>;
          }):<tr><td colSpan={COLUMNS.length}>{q||provider||view!=="all"?"No models match these filters.":"No candidates stored. Run discovery to query the live sources."}</td></tr>}</tbody>
        </table>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 15px",fontSize:11,color:"var(--muted)",borderTop:"1px solid var(--border)"}}>
        <span>{result.total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${result.total.toLocaleString()}` : "0 models"}</span>
        <span style={{display:"flex",gap:12,alignItems:"center"}}>
          {result.page>1?<Link href={link({ page: String(result.page-1) })} rel="prev">← Previous</Link>:<span style={{color:"var(--faint)"}}>← Previous</span>}
          <span>Page {result.page} of {result.pageCount.toLocaleString()}</span>
          {result.page<result.pageCount?<Link href={link({ page: String(result.page+1) })} rel="next">Next →</Link>:<span style={{color:"var(--faint)"}}>Next →</span>}
        </span>
      </div>
    </section>
  </PageShell>;
}

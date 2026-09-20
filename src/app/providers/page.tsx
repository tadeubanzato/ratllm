import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
import { Tooltip } from "@/components/tooltip";
import { timeAgo } from "@/lib/utils";
import { demoProviders } from "@/server/demo-data";
import {
  getProviders,
  getProviderSmokeHistory,
  getProviderSourceCheckHistory,
  getProviderSourceBreakdown,
  withDemo,
} from "@/server/queries";
import type { ProviderSourceBreakdown } from "@/server/queries";
import type { SmokeHistoryPoint } from "@/server/queries";
import type { SourceCheckPoint } from "@/server/queries";
import { getIntegrationStatus, integrationStatusLabels } from "@/server/providers/wiring";
import { FREE_KIND_LABELS } from "@/server/discovery/verification-policy";
import type { ProviderRow } from "@/server/queries";

export const dynamic = "force-dynamic";

/** Trend sparkline — discovery source check history. */
function SourceSparkline({ points }: { points: SourceCheckPoint[] }) {
  if (points.length === 0) return <span className="status-pill status-pill-soft status-pill-xs">No data</span>;
  const colourMap: Record<string, string> = {
    "HEALTHY": "var(--green)",
    "DEGRADED": "var(--amber)",
    "FAILED": "var(--red)",
    "BLOCKED": "var(--red)",
    "UNKNOWN": "var(--muted)",
  };
  const max = 24;
  const step = Math.max(1, Math.ceil(points.length / max));
  const selected = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 0 }}>
      {selected.map((p) => {
        const idx = points.indexOf(p);
        return (
          <span
            key={idx}
            title={`${p.status}${p.httpStatus ? ` · HTTP ${p.httpStatus}` : ""}${p.error ? ` · ${p.error}` : ""}`}
            style={{ width: 3, height: 14, borderRadius: 1, background: colourMap[p.status] ?? "var(--muted)", display: "inline-block", flexShrink: 0 }}
          />
        );
      })}
      {points.length > max && (
        <span style={{ color: "var(--muted)", fontSize: 9, marginLeft: 4, whiteSpace: "nowrap" }}>
          +{points.length - max}
        </span>
      )}
    </span>
  );
}

/** Smoke-test sparkline (fallback for deployed-model health). */
function SmokeSparkline({ points }: { points: SmokeHistoryPoint[] }) {
  if (points.length === 0) return null;
  const colourMap: Record<string, string> = {
    "PASSED": "var(--green)",
    "rate_limited": "var(--amber)",
    "FAILED": "var(--red)",
  };
  const max = 20;
  const step = Math.max(1, Math.ceil(points.length / max));
  const selected = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 0 }}>
      {selected.map((p) => {
        const idx = points.indexOf(p);
        return (
          <span
            key={idx}
            title={`${p.status}${p.httpStatus ? ` · HTTP ${p.httpStatus}` : ""}${p.error ? ` · ${p.error}` : ""}`}
            style={{ width: 3, height: 13, borderRadius: 1, background: colourMap[p.status] ?? "var(--muted)", display: "inline-block", flexShrink: 0 }}
          />
        );
      })}
      {points.length > max && (
        <span style={{ color: "var(--muted)", fontSize: 9, marginLeft: 4, whiteSpace: "nowrap" }}>
          +{points.length - max}
        </span>
      )}
    </span>
  );
}

/** Trend column cell. Shows source-check sparkline; falls back to the smoke-test sparkline only when there is no
 *  source-check history at all (not a second bar shown alongside it). */
function TrendCell({ sourcePoints, smokePoints }: { sourcePoints: SourceCheckPoint[]; smokePoints: SmokeHistoryPoint[] }) {
  if (sourcePoints.length === 0 && smokePoints.length === 0) {
    return (
      <td style={{ color: "var(--muted)", fontSize: 10.5, padding: "0 12px" }}>
        <span className="status-pill status-pill-soft status-pill-xs">No data</span>
      </td>
    );
  }
  return (
    <td style={{ color: "var(--muted)", fontSize: 10.5, padding: "0 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: "100%" }}>
        {sourcePoints.length > 0 ? <SourceSparkline points={sourcePoints} /> : <SmokeSparkline points={smokePoints} />}
      </div>
    </td>
  );
}

/** Whether models of this provider can be tested yet, and what to do if not. Derived from what is known (endpoint, credential). */
const READINESS: Record<NonNullable<ProviderRow["readiness"]>, { label: string; tone: "good" | "warn" | "neutral"; hint: string }> = {
  READY: { label: "Ready", tone: "good", hint: "Endpoint known and credential verified — its models are being tested." },
  UNVERIFIED: { label: "Verify credential", tone: "warn", hint: "A credential is stored but has not been verified yet." },
  NEEDS_CREDENTIAL: { label: "Needs credential", tone: "neutral", hint: "Discovered, but no credential is stored, so its models cannot be tested." },
  NO_ENDPOINT: { label: "Needs base URL", tone: "warn", hint: "Discovered, but no source has published where to send requests. Set a Base URL on the provider page." },
};

function offerTooltip(row: ProviderRow): string {
  const offer = row.offer;
  if (!offer) return "No source has published this provider's free offer.";
  return [offer.freeTierText && `Free tier: ${offer.freeTierText}`, offer.rateLimitsText && `Limits: ${offer.rateLimitsText}`, offer.expiresAt && `Expires: ${offer.expiresAt}`,
    offer.cardRequired !== null && `Card required: ${offer.cardRequired ? "yes" : "no"}`, offer.commercialOk !== null && `Commercial use: ${offer.commercialOk ? "ok" : "not allowed"}`,
    `Source: ${offer.source}${offer.sourceLastVerified ? `, verified ${offer.sourceLastVerified}` : ""}`].filter(Boolean).join(" · ");
}

const VIEWS = [
  { id: "all", label: "All" }, { id: "with-models", label: "With models" }, { id: "discovered", label: "Discovered" }, { id: "setup", label: "Needs setup" },
] as const;
type View = (typeof VIEWS)[number]["id"];
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default async function ProvidersPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const view = (VIEWS.some(item => item.id === first(params.view)) ? first(params.view) : "all") as View;
  const q = first(params.q)?.trim().toLowerCase().slice(0, 80);
  const [allRows, smokeHistory, sourceHistory, sourceBreakdown] = await Promise.all([
    withDemo(getProviders, () => demoProviders),
    withDemo(() => getProviderSmokeHistory(20), () => new Map<string, SmokeHistoryPoint[]>()),
    withDemo(() => getProviderSourceCheckHistory(30), () => new Map<string, SourceCheckPoint[]>()),
    withDemo(getProviderSourceBreakdown, () => new Map<string, ProviderSourceBreakdown[]>()),
  ]);
  const matches: Record<View, (row: ProviderRow) => boolean> = {
    all: () => true, "with-models": row => row.knownCount > 0 || row.modelCount > 0, discovered: row => row.origin === "DISCOVERED",
    setup: row => row.readiness !== undefined && row.readiness !== "READY" && row.knownCount > 0,
  };
  const rows = allRows.filter(row => matches[view](row) && (!q || `${row.name} ${row.slug}`.toLowerCase().includes(q)));
  const viewCount = (id: View) => allRows.filter(matches[id]).length;
  const href = (id: View) => id === "all" ? "/providers" : `/providers?view=${id}`;
  return (
    <PageShell title="Providers" eyebrow={`${allRows.length} providers · derived from what discovery sources report`}>
      <section className="panel">
        <div className="panel-header" style={{ height: "auto", padding: "10px 15px", flexWrap: "wrap", gap: 10 }}>
          <nav aria-label="Filter providers" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {VIEWS.map(item => <Link key={item.id} href={href(item.id)} aria-current={view === item.id ? "page" : undefined} className={`status-pill status-pill-sm ${view === item.id ? "status-info" : "status-neutral"}`} style={{ fontSize: 10, padding: "3px 10px", textDecoration: "none" }}>{item.label} · {viewCount(item.id)}</Link>)}
          </nav>
          <form method="get" action="/providers" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {view !== "all" ? <input type="hidden" name="view" value={view} /> : null}
            <input name="q" defaultValue={q ?? ""} placeholder="Search providers" aria-label="Search providers" style={{ fontSize: 11, padding: "5px 9px", border: "1px solid var(--border-strong)", borderRadius: 6, background: "var(--surface)", color: "var(--text)", minWidth: 190 }} />
            <button type="submit" className="settings-link-button" style={{ fontSize: 11 }}>Search</button>
          </form>
        </div>
        <div className="table-scroll">
          <table className="data-table" style={{ tableLayout: "fixed", minWidth: 1000 }}>
            <colgroup>{["22%", "9%", "13%", "11%", "17%", "9%", "19%"].map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Setup</th>
                <th>Free offer</th>
                <th>Models</th>
                <th>Trend</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={7}>No providers match.</td></tr> : rows.map((row) => {
                const sourcePoints = sourceHistory.get(row.id) ?? [];
                const smokePoints = (smokeHistory.get(row.id) ?? []).map((item) => ({
                  at: item.at,
                  status: item.httpStatus === 429 ? "rate_limited" : item.status,
                  httpStatus: item.httpStatus,
                  latencyMs: item.latencyMs,
                  error: item.error,
                }));
                const integration = getIntegrationStatus(
                  row.slug,
                  { configured: row.credentialConfigured, verified: row.credentialVerified === true },
                  row.modelCount > 0,
                );
                const breakdown = sourceBreakdown.get(row.id) ?? [];
                const readiness = READINESS[row.readiness ?? "NEEDS_CREDENTIAL"];
                return (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: "normal" }}>
                      <Link href={`/providers/${row.id}`}>
                        <strong>{row.name}</strong>
                        {row.origin === "DISCOVERED" ? <span className="status-pill status-pill-xs status-info" style={{ marginLeft: 6 }}>Discovered</span> : null}
                        <br />
                        <span className="mono" style={{ fontSize: 9.5 }}>{row.slug}</span>
                      </Link>
                      <div style={{ fontSize: 9.5, color: "var(--faint)" }}>{row.lastDiscoveryAt ? `seen ${timeAgo(row.lastDiscoveryAt)}` : "not seen by discovery yet"} · {integrationStatusLabels[integration]}</div>
                    </td>
                    <td>
                      <StatusPill value={row.enabled === false ? "SKIPPED" : row.status} variant="soft" size="sm" />
                    </td>
                    <td style={{ whiteSpace: "normal" }}>
                      <Tooltip label={readiness.hint}><Link href={`/providers/${row.id}`} className={`status-pill status-pill-sm status-${readiness.tone}`} style={{ textDecoration: "none" }}>{readiness.label}</Link></Tooltip>
                    </td>
                    <td>
                      <Tooltip label={offerTooltip(row)}>
                        <span className={`status-pill status-pill-sm ${row.freeKind === "FOREVER" ? "status-good" : row.freeKind === "UNKNOWN" || row.freeKind === undefined ? "status-neutral" : "status-warn"}`}>{FREE_KIND_LABELS[row.freeKind ?? "UNKNOWN"]}</span>
                      </Tooltip>
                    </td>
                    <td style={{ whiteSpace: "normal" }}>
                      {row.knownCount > 0 ? <Link href={`/models?provider=${row.slug}`} style={{ color: "inherit" }}><strong>{row.knownCount.toLocaleString()}</strong> discovered</Link> : <span style={{ color: "var(--faint)" }}>none discovered</span>}
                      <div style={{ fontSize: 9.5, color: "var(--faint)" }}>{(row.passingCount ?? 0).toLocaleString()} passing · {(row.readyCount ?? 0).toLocaleString()} ready · {row.modelCount.toLocaleString()} in LiteLLM</div>
                    </td>
                    <TrendCell sourcePoints={sourcePoints} smokePoints={smokePoints} />
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                        {breakdown.slice(0, 4).map((item) => {
                          const tierTone = item.tier === "A1" ? "good" : item.tier === "A2" ? "warn" : item.tier === "B" ? "warn" : "neutral";
                          return (
                            <span key={item.source} className="coverage-tag" title={`${item.source}: ${item.count} models`} style={{ background: `color-mix(in srgb, var(--${tierTone}) 15%, transparent)`, color: `var(--${tierTone})`, fontSize: 9, padding: "1px 5px", borderRadius: 3 }}>
                              {item.source.split(" ").slice(0, 2).join(" ")}
                            </span>
                          );
                        })}
                        {breakdown.length > 4 && <span style={{ fontSize: 9, color: "var(--muted)" }}>+{breakdown.length - 4}</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </PageShell>
  );
}

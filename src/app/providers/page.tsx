import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { StatusPill } from "@/components/status-pill";
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
import { getIntegrationStatus, integrationStatusLabels, integrationStatusTone } from "@/server/providers/wiring";

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

/** Availability indicator — maps the provider's availability state to a standard status-pill. */
function AvailabilityPill({ availability, sourceLastSync }: { availability: string; sourceLastSync: Date | null }) {
  const map: Record<string, { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
    verified:      { label: "Verified",      tone: "good" },
    configured:    { label: "Configured",    tone: "warn" },
    discovering:   { label: "Active",        tone: "good" },
    no_credential: { label: "No credential", tone: "neutral" },
    failed:        { label: "Failed",        tone: "bad" },
    blocked:       { label: "Blocked",       tone: "bad" },
    unknown:       { label: "—",             tone: "neutral" },
  };
  const entry = map[availability] ?? map.unknown;
  const label = sourceLastSync ? `${entry.label} · ${timeAgo(sourceLastSync)}` : entry.label;
  return <StatusPill value={label} variant="soft" size="sm" />;
}

export default async function ProvidersPage() {
  const [rows, smokeHistory, sourceHistory, sourceBreakdown] = await Promise.all([
    withDemo(getProviders, () => demoProviders),
    withDemo(() => getProviderSmokeHistory(20), () => new Map<string, SmokeHistoryPoint[]>()),
    withDemo(() => getProviderSourceCheckHistory(30), () => new Map<string, SourceCheckPoint[]>()),
    withDemo(getProviderSourceBreakdown, () => new Map<string, ProviderSourceBreakdown[]>()),
  ]);
  return (
    <PageShell title="Providers" eyebrow={`${rows.length} integrations`}>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Availability</th>
                <th>Trend</th>
                <th>Credential</th>
                <th>Integration</th>
                <th>Discovery</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
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
                return (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/providers/${row.id}`}>
                        <strong>{row.name}</strong>
                        <br />
                        <span className="mono" style={{ fontSize: 9.5 }}>
                          {row.slug}
                        </span>
                      </Link>
                    </td>
                    <td>
                      <StatusPill value={row.enabled === false ? "SKIPPED" : row.status} variant="soft" size="sm" />
                    </td>
                    <td>
                      <AvailabilityPill availability={row.availability} sourceLastSync={row.sourceLastSync} />
                    </td>
                    <TrendCell sourcePoints={sourcePoints} smokePoints={smokePoints} />
                    <td>
                      <StatusPill
                        value={row.credentialVerified ? "Verified" : row.credentialConfigured ? "Configured" : "Missing"}
                        tooltip={null}
                        variant="soft" size="sm"
                      />
                    </td>
                    <td>
                      <span className={`status-pill status-${integrationStatusTone[integration]}`}>
                        {integrationStatusLabels[integration]}
                      </span>
                    </td>
                    <td style={{ fontSize: 10.5 }}>
                      {row.lastDiscoveryAt ? (
                        <span style={{ color: "var(--muted)" }}>{timeAgo(row.lastDiscoveryAt)}</span>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>Manual</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, maxWidth: 280 }}>
                        {breakdown.slice(0, 5).map((item) => {
                          const tierTone = item.tier === "A1" ? "good" : item.tier === "A2" ? "warn" : item.tier === "B" ? "warn" : "neutral";
                          return (
                            <span
                              key={item.source}
                              className="coverage-tag"
                              style={{
                                background: `color-mix(in srgb, var(--${tierTone}) 15%, transparent)`,
                                color: `var(--${tierTone})`,
                                fontSize: 9,
                                padding: "1px 5px",
                                borderRadius: 3,
                              }}
                            >
                              {item.source.split(" ").slice(0, 2).join(" ")}
                            </span>
                          );
                        })}
                        {breakdown.length > 5 && (
                          <span style={{ fontSize: 9, color: "var(--muted)" }}>+{breakdown.length - 5}</span>
                        )}
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

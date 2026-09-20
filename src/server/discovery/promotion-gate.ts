import { sourceRegistry } from "./registry";

const candidateOnlySources = new Set(sourceRegistry.filter(source => source.candidateOnly).map(source => source.id));

/**
 * Source-authority gate for adding a candidate to LiteLLM. Tier B/C sources (community lists, third-party
 * directories) are flagged `candidateOnly` in the registry: they can surface a lead but never establish that a model
 * is free or route it. A candidate is only blocked when no stronger source also reported it — consolidation records
 * every other reporting source as `corroboratingSources`, so a model an official catalog also lists is unaffected.
 *
 * Returns the human-readable reason, or null when the candidate's sources permit promotion. Both the manual and
 * automatic promotion paths use this, so hiding a button in the UI is never the only enforcement.
 */
export function candidateOnlyBlockReason(candidate: { source: string; evidence?: Record<string, unknown> | null }, candidateOnly: ReadonlySet<string> = candidateOnlySources): string | null {
  if (!candidateOnly.has(candidate.source)) return null;
  const corroborators = Array.isArray(candidate.evidence?.corroboratingSources) ? candidate.evidence.corroboratingSources as Array<{ source?: unknown }> : [];
  const corroboratedByAuthority = corroborators.some(item => typeof item?.source === "string" && !candidateOnly.has(item.source));
  return corroboratedByAuthority ? null : "Only reported by a community/third-party list — a lead, not proof it is free. Confirm it with an official source before adding it.";
}

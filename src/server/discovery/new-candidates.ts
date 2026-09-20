import { bareModelKey } from "./model-key";

/** How long a genuinely new model keeps its "New" badge after discovery first found it. */
export const NEW_CANDIDATE_WINDOW_MS = 24 * 60 * 60_000;
/** Rows a source first wrote within this long of its very first row are that source's initial ingest — a baseline
 *  dump of everything it already listed, not a discovery. Discovery writes a whole run with one timestamp, so this
 *  only needs to absorb clock skew and a slow first run. */
export const SOURCE_BASELINE_MS = 30 * 60_000;

export interface NewnessInput {
  id: string;
  source: string;
  providerId: string | null;
  modelRef: string;
  firstSeenAt: Date;
  /** Any LiteLLM deployment row matching this model, in any lifecycle (live, deactivated or removed). */
  liteLLMLifecycle: string | null;
  liteLLMDeploymentId: string | null;
}

/** Which candidates deserve the "New" badge: models discovery found for the first time, for a provider on the
 *  Providers list, recently. Everything that merely looks recent is excluded:
 *
 *  - already in LiteLLM (live, deactivated or removed) — it was added on purpose, so it is not something to notice;
 *  - no resolved provider — an aggregator bucket, not a provider RatLLM tracks;
 *  - part of a source's first ingest — adding a source dumps its whole catalogue at once, which is not 400 discoveries;
 *  - already known from an older row for the same provider and model — a second source listing a model we had
 *    is not a new model (candidate rows are unique per source, so this shows up as a fresh row with a fresh date).
 *
 *  Pure, so the whole rule is unit-tested rather than verified by eyeballing the page. */
export function newlyDiscoveredIds(rows: readonly NewnessInput[], now = Date.now()): Set<string> {
  const sourceFirst = new Map<string, number>();
  const modelFirst = new Map<string, number>();
  const modelKey = (row: NewnessInput) => `${row.providerId}|${bareModelKey(row.modelRef)}`;
  for (const row of rows) {
    const seen = row.firstSeenAt.getTime();
    sourceFirst.set(row.source, Math.min(sourceFirst.get(row.source) ?? Infinity, seen));
    if (row.providerId) modelFirst.set(modelKey(row), Math.min(modelFirst.get(modelKey(row)) ?? Infinity, seen));
  }
  const result = new Set<string>();
  for (const row of rows) {
    const seen = row.firstSeenAt.getTime();
    if (!row.providerId) continue;
    if (row.liteLLMDeploymentId || row.liteLLMLifecycle) continue;
    if (now - seen >= NEW_CANDIDATE_WINDOW_MS) continue;
    if (seen - (sourceFirst.get(row.source) ?? seen) < SOURCE_BASELINE_MS) continue;
    if (seen > (modelFirst.get(modelKey(row)) ?? seen)) continue;
    result.add(row.id);
  }
  return result;
}

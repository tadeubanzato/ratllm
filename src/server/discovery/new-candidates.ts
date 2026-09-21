import { bareModelKey } from "./model-key";
import { candidateOnlyBlockReason } from "./promotion-gate";

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
  /** The candidate's recorded blocker (`check_blocker`) and evidence, used to tell "waiting" from "can never be added". */
  checkBlocker?: string | null;
  evidence?: Record<string, unknown> | null;
}

/** Which candidates deserve the "New" badge: models discovery found for the first time, for a provider on the
 *  Providers list, that are not in LiteLLM yet and could still be added. The badge has no expiry: it stays until the model has been added (or was, and
 *  removed), so a model that automatic promotion keeps deferring (lanes full, credential not ready) is never forgotten just
 *  because a day passed. Everything that merely looks recent is excluded:
 *
 *  - permanently blocked — not a chat model (a classifier, speech, embedding or image model) or reported only by a community
 *    list: no amount of waiting gets it into LiteLLM, and the Discovered Models page shows its blocker instead. Blockers that a
 *    person or time can clear (credential, endpoint, full lanes) keep the badge;
 *  - already in LiteLLM (live, deactivated or removed) — it was added on purpose, so it is not something to notice;
 *  - no resolved provider — an aggregator bucket, not a provider RatLLM tracks;
 *  - part of a source's first ingest — adding a source dumps its whole catalogue at once, which is not 400 discoveries;
 *  - already known from an older row for the same provider and model — a second source listing a model we had
 *    is not a new model (candidate rows are unique per source, so this shows up as a fresh row with a fresh date).
 *
 *  `baselineEpoch` marks a change in how candidates are identified (docs/DISCOVERY-PIPELINE.md I10): models a source always listed
 *  but that were hidden by the old one-row-per-model-id rule surface for the first time in the next run, and they are not
 *  discoveries. From the epoch on, each source's first ingest is measured from its first run *since* the epoch, so that run is a
 *  baseline and later runs are not. With no epoch this is exactly the rule above.
 *
 *  Pure, so the whole rule is unit-tested rather than verified by eyeballing the page. */
export function newlyDiscoveredIds(rows: readonly NewnessInput[], baselineEpoch: Date | null = null): Set<string> {
  const sourceFirst = new Map<string, number>();
  const sourceFirstSinceEpoch = new Map<string, number>();
  const modelFirst = new Map<string, number>();
  const modelKey = (row: NewnessInput) => `${row.providerId}|${bareModelKey(row.modelRef)}`;
  for (const row of rows) {
    const seen = row.firstSeenAt.getTime();
    sourceFirst.set(row.source, Math.min(sourceFirst.get(row.source) ?? Infinity, seen));
    if (baselineEpoch && seen >= baselineEpoch.getTime()) sourceFirstSinceEpoch.set(row.source, Math.min(sourceFirstSinceEpoch.get(row.source) ?? Infinity, seen));
    if (row.providerId) modelFirst.set(modelKey(row), Math.min(modelFirst.get(modelKey(row)) ?? Infinity, seen));
  }
  // A source's baseline is its first ingest since the epoch when there is one (see below), otherwise its first ingest ever.
  const baselineOf = (source: string) => sourceFirstSinceEpoch.get(source) ?? sourceFirst.get(source);
  const result = new Set<string>();
  for (const row of rows) {
    const seen = row.firstSeenAt.getTime();
    if (!row.providerId) continue;
    if (row.liteLLMDeploymentId || row.liteLLMLifecycle) continue;
    if (row.checkBlocker === "NOT_CHAT_MODEL" || typeof row.evidence?.nonChatReason === "string") continue;
    if (candidateOnlyBlockReason({ source: row.source, evidence: row.evidence ?? null })) continue;
    if (seen - (baselineOf(row.source) ?? seen) < SOURCE_BASELINE_MS) continue;
    if (seen > (modelFirst.get(modelKey(row)) ?? seen)) continue;
    result.add(row.id);
  }
  return result;
}

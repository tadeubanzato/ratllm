/** Pure re-add safety policy for candidates that have been auto-removed from LiteLLM before — no DB, no
 *  server-only, safe to unit-test in isolation. See docs/FREE-MODEL-LIFECYCLE.md §5.
 *
 *  A removal is inconclusive proof of anything on its own — it might be a genuine dead model, or a LiteLLM-side
 *  routing/quota issue the direct-to-provider check can never see. Two rules keep that ambiguity from turning
 *  into an infinite flap loop (removed -> direct checks still pass -> re-added -> fails through LiteLLM again):
 *
 *  - A cooldown: a fresh pass right after removal isn't trusted until at least one full recheck cycle has
 *    actually elapsed.
 *  - A flap limit: a candidate that has been auto-removed repeatedly in a rolling window stops being
 *    auto-re-added at all — it needs a human to click "Add to LiteLLM" once, which resets its history. */

export const REMOVE_COOLDOWN_MS = 6 * 60 * 60_000;
export const FLAP_LIMIT = 3;
export const FLAP_WINDOW_MS = 30 * 24 * 60 * 60_000;

export interface RemovalRecord { at: string; reason: string }

export function removalHistoryOf(evidence: Record<string, unknown>): RemovalRecord[] {
  const value = evidence.removalHistory;
  return Array.isArray(value) ? value as RemovalRecord[] : [];
}

/** Removals of one candidate this close together are one event. A model deployed in several lanes has several deployments failing for
 *  the same reason, and each one's removal used to add its own entry, so a model in three lanes hit the flap limit (3) with a single
 *  incident and was never auto-re-added. The cooldown is hours long, so two genuine removals cannot fall this close. */
export const SAME_REMOVAL_EVENT_MS = 30 * 60_000;

/** The history with `record` added, unless it is the same event as the most recent entry. */
export function withRemoval(history: readonly RemovalRecord[], record: RemovalRecord): RemovalRecord[] {
  const last = history.at(-1);
  if (last && Math.abs(new Date(record.at).getTime() - new Date(last.at).getTime()) < SAME_REMOVAL_EVENT_MS) return [...history];
  return [...history, record];
}

export function inRemovalCooldown(history: readonly RemovalRecord[], now = Date.now()): boolean {
  const last = history.at(-1);
  return Boolean(last) && now - new Date(last!.at).getTime() < REMOVE_COOLDOWN_MS;
}

export function isFlapLimited(history: readonly RemovalRecord[], now = Date.now()): boolean {
  return history.filter(item => now - new Date(item.at).getTime() < FLAP_WINDOW_MS).length >= FLAP_LIMIT;
}

/** Whether automation should refrain from auto-re-adding this candidate right now — either it hasn't cleared
 *  the post-removal cooldown yet, or it's flapped too many times and needs a human to look at it. */
export function isAutoReAddBlocked(evidence: Record<string, unknown>, now = Date.now()): boolean {
  const history = removalHistoryOf(evidence);
  return inRemovalCooldown(history, now) || isFlapLimited(history, now);
}

/** After a deferral (lanes full, credential not ready) auto-add waits this long before trying the same candidate again. */
export const AUTO_ADD_DEFER_MS = 6 * 60 * 60_000;

export function isAutoAddDeferred(evidence: Record<string, unknown>, now = Date.now()): boolean {
  const until = evidence.autoAddDeferredUntil;
  if (typeof until !== "string") return false;
  const at = new Date(until).getTime();
  return Number.isFinite(at) && at > now;
}

export function autoAddDeferredUntil(now = Date.now()): string { return new Date(now + AUTO_ADD_DEFER_MS).toISOString(); }

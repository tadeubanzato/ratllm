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

/** A candidate whose most recent direct check wasn't a clean pass (or has never been checked at all) has zero
 *  chance of surviving `promoteCandidate`'s live re-verify — offering the manual "Add to LiteLLM" button for it
 *  just invites a click that fails immediately. This only ever narrows the *first-time* promotion path: a
 *  candidate that's already been live before (flap-limited "needs review", or manually deleted) reaches this
 *  same `lastStatus` value through its own recheck cycle, and by construction keeps passing directly (that
 *  disagreement with LiteLLM is exactly what makes it flap-limited) — so this never hides the human-override
 *  button those cases are supposed to keep. See docs/FREE-MODEL-LIFECYCLE.md §3/§6: automation (fast-track ramp
 *  + 5-in-a-row) is the intended path to promotion; the manual button is only ever a shortcut once there's
 *  actual evidence the candidate works. */
export function unprovenCheckReason(evidence: Record<string, unknown>): string | null {
  const lastStatus = typeof evidence.lastStatus === "string" ? evidence.lastStatus : null;
  if (lastStatus === "available") return null;
  return lastStatus ? "Last check did not pass yet" : "Not checked yet";
}

/** The rules of direct verification, as pure functions (docs/DISCOVERY-PIPELINE.md §6, invariants I6-I8). No database and no
 *  `server-only`, so every rule here is unit-tested in isolation and shared by the verifier, the promotion gate and the UI. */

/** Consecutive real passes before a candidate may be added to LiteLLM (I8). */
export const PROMOTION_PASSES = 5;

/** What a real provider call can come back as. Anything that was not a call (no credential, no endpoint, not a chat model)
 *  is a blocker, never an outcome, and never appears here. */
export type CheckOutcome = "available" | "unavailable" | "rate_limited" | "auth_error" | "out_of_credits";

// ── Free kind ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The three things "free" can mean to someone deciding whether to depend on a model, plus the two honest non-answers. The
 *  database's free_type enum is finer-grained; this is the level people reason at and the level testing cadence depends on. */
export type FreeKind = "FOREVER" | "RECURRING" | "TRIAL" | "UNKNOWN" | "PAID";

const KIND_OF: Readonly<Record<string, FreeKind>> = {
  PERMANENT_FREE: "FOREVER", FREE_TIER: "FOREVER", OPEN_WEIGHT_SELF_HOSTED: "FOREVER", PROVIDER_SPECIFIC_FREE: "FOREVER",
  RECURRING_DAILY: "RECURRING", RECURRING_MONTHLY: "RECURRING", RECURRING_CREDIT: "RECURRING",
  TRIAL_CREDIT: "TRIAL", TRIAL_QUOTA: "TRIAL", PROMOTIONAL: "TRIAL",
  PAID: "PAID",
};

export const FREE_KIND_LABELS: Readonly<Record<FreeKind, string>> = { FOREVER: "Free", RECURRING: "Recurring quota", TRIAL: "Trial credits", UNKNOWN: "Unknown", PAID: "Paid" };

export function freeKindOf(freeType: string | null | undefined): FreeKind {
  return (freeType && KIND_OF[freeType]) || "UNKNOWN";
}

/** A candidate's own free type if a source stated one; otherwise what its provider's offer says. Never a guess: with neither, UNKNOWN. */
export function effectiveFreeKind(candidateFreeType: string | null | undefined, offerFreeTypes: ReadonlyArray<string | null | undefined> = []): FreeKind {
  const own = freeKindOf(candidateFreeType);
  if (own !== "UNKNOWN") return own;
  return offerFreeTypes.map(freeKindOf).find(kind => kind !== "UNKNOWN") ?? "UNKNOWN";
}

/** Recurring-quota and trial offers are consumed by every test call, so they are tested less often than a free-forever model. */
export const isMetered = (kind: FreeKind) => kind === "RECURRING" || kind === "TRIAL";

// ── Cadence ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000, HOUR = 60 * MINUTE;

/** How long to wait before testing again. A candidate that has never failed and has not yet earned its promotion streak is
 *  "proving": tested often, so a good new model can qualify in hours instead of days. Metered offers are tested a quarter as
 *  often, because a test that spends a trial credit or a monthly quota is not free. Once it fails or is added, it drops to the
 *  normal cadence for good. */
export function recheckDelayMs(input: { outcome: CheckOutcome; kind: FreeKind; proving: boolean }): number {
  const metered = isMetered(input.kind);
  if (input.outcome === "rate_limited" || input.outcome === "out_of_credits") return 24 * HOUR;
  if (input.outcome === "available" && input.proving) return metered ? 6 * HOUR : 90 * MINUTE;
  return metered ? 24 * HOUR : 6 * HOUR;
}

// ── State machine ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CheckState { consecutivePasses: number; everFailed: boolean; lastPassedAt: Date | null }

export interface CheckTransition extends CheckState { lastCheckStatus: CheckOutcome; lastCheckedAt: Date; nextCheckAt: Date }

/** What one real result does to a candidate's state (I7): a pass extends the streak; anything else, including a 429 or an
 *  out-of-credits answer, ends it. `alreadyInLiteLLM` matters only for cadence: a model that is already added is no longer
 *  "proving". */
export function applyCheckOutcome(previous: CheckState, outcome: CheckOutcome, options: { kind: FreeKind; alreadyInLiteLLM?: boolean; now?: Date }): CheckTransition {
  const now = options.now ?? new Date();
  const passed = outcome === "available";
  const consecutivePasses = passed ? previous.consecutivePasses + 1 : 0;
  const everFailed = previous.everFailed || !passed;
  const proving = passed && !previous.everFailed && !options.alreadyInLiteLLM && consecutivePasses < PROMOTION_PASSES;
  return {
    consecutivePasses, everFailed, lastPassedAt: passed ? now : previous.lastPassedAt,
    lastCheckStatus: outcome, lastCheckedAt: now,
    nextCheckAt: new Date(now.getTime() + recheckDelayMs({ outcome, kind: options.kind, proving })),
  };
}

// ── Promotion gate ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a candidate has earned being added to LiteLLM (I8): PROMOTION_PASSES consecutive real passes. A candidate that has
 *  already been in LiteLLM and was removed keeps the documented human-override path (docs/FREE-MODEL-LIFECYCLE.md §3): its
 *  latest real check merely has to have passed, because the disagreement between a passing direct check and a failing routed
 *  one is exactly what got it removed, and a person deciding to try again must not be blocked by the streak it lost. */
export function promotionGateReason(input: { consecutivePasses: number; lastCheckStatus: string | null; previouslyInLiteLLM: boolean }): string | null {
  if (input.consecutivePasses >= PROMOTION_PASSES) return null;
  if (input.previouslyInLiteLLM && input.lastCheckStatus === "available") return null;
  if (!input.lastCheckStatus) return "Not tested yet";
  return `${input.consecutivePasses} of ${PROMOTION_PASSES} passes in a row`;
}

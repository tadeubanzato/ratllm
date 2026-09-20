import { describe, expect, it } from "vitest";
import { applyCheckOutcome, effectiveFreeKind, freeKindOf, isMetered, promotionGateReason, PROMOTION_PASSES, recheckDelayMs, type CheckState } from "../src/server/discovery/verification-policy";

const HOUR = 3_600_000;
const fresh: CheckState = { consecutivePasses: 0, everFailed: false, lastPassedAt: null };
const NOW = new Date("2026-09-20T12:00:00Z");

describe("free kind", () => {
  it("maps every database free type to what a person means by it", () => {
    expect(["PERMANENT_FREE", "FREE_TIER", "OPEN_WEIGHT_SELF_HOSTED", "PROVIDER_SPECIFIC_FREE"].map(freeKindOf)).toEqual(Array(4).fill("FOREVER"));
    expect(["RECURRING_DAILY", "RECURRING_MONTHLY", "RECURRING_CREDIT"].map(freeKindOf)).toEqual(Array(3).fill("RECURRING"));
    expect(["TRIAL_CREDIT", "TRIAL_QUOTA", "PROMOTIONAL"].map(freeKindOf)).toEqual(Array(3).fill("TRIAL"));
    expect(freeKindOf("PAID")).toBe("PAID");
  });

  it("never guesses: an unknown or unrecognised type is UNKNOWN", () => {
    for (const value of ["UNKNOWN", "SOMETHING_NEW", "", null, undefined]) expect(freeKindOf(value)).toBe("UNKNOWN");
  });

  it("uses the candidate's own type, then its provider's offer, then UNKNOWN", () => {
    expect(effectiveFreeKind("FREE_TIER", ["TRIAL_CREDIT"])).toBe("FOREVER");
    expect(effectiveFreeKind("UNKNOWN", ["UNKNOWN", "TRIAL_CREDIT"])).toBe("TRIAL");
    expect(effectiveFreeKind("UNKNOWN", [])).toBe("UNKNOWN");
  });
});

describe("cadence — metered offers are tested less often", () => {
  it("tests a free-forever or unknown model every 6h, and proves a new one every 90 minutes", () => {
    for (const kind of ["FOREVER", "UNKNOWN"] as const) {
      expect(recheckDelayMs({ outcome: "available", kind, proving: false })).toBe(6 * HOUR);
      expect(recheckDelayMs({ outcome: "available", kind, proving: true })).toBe(90 * 60_000);
      expect(recheckDelayMs({ outcome: "unavailable", kind, proving: false })).toBe(6 * HOUR);
    }
  });

  it("tests a trial or recurring-quota model every 24h, and proves a new one every 6h", () => {
    for (const kind of ["TRIAL", "RECURRING"] as const) {
      expect(isMetered(kind)).toBe(true);
      expect(recheckDelayMs({ outcome: "available", kind, proving: false })).toBe(24 * HOUR);
      expect(recheckDelayMs({ outcome: "available", kind, proving: true })).toBe(6 * HOUR);
      expect(recheckDelayMs({ outcome: "unavailable", kind, proving: false })).toBe(24 * HOUR);
    }
  });

  it("waits a day after a rate limit or an empty account, for every kind", () => {
    for (const kind of ["FOREVER", "RECURRING", "TRIAL", "UNKNOWN"] as const)
      for (const outcome of ["rate_limited", "out_of_credits"] as const) expect(recheckDelayMs({ outcome, kind, proving: true })).toBe(24 * HOUR);
  });
});

describe("check state machine (I7)", () => {
  it("counts consecutive real passes", () => {
    let state: CheckState = fresh;
    for (let i = 1; i <= 7; i++) { state = applyCheckOutcome(state, "available", { kind: "FOREVER", now: NOW }); expect(state.consecutivePasses).toBe(i); }
    expect(state.lastPassedAt).toEqual(NOW);
  });

  it.each(["unavailable", "rate_limited", "auth_error", "out_of_credits"] as const)("a %s result ends the streak", outcome => {
    const before: CheckState = { consecutivePasses: 4, everFailed: false, lastPassedAt: new Date("2026-09-19T00:00:00Z") };
    const after = applyCheckOutcome(before, outcome, { kind: "FOREVER", now: NOW });
    expect(after.consecutivePasses).toBe(0);
    expect(after.everFailed).toBe(true);
    expect(after.lastPassedAt).toEqual(before.lastPassedAt); // a failure does not erase when it last passed
    expect(after.lastCheckStatus).toBe(outcome);
  });

  it("stops proving after the first failure, and after the streak is earned, and once it is in LiteLLM", () => {
    const passOnce = (state: CheckState, extra = {}) => applyCheckOutcome(state, "available", { kind: "FOREVER", now: NOW, ...extra }).nextCheckAt.getTime() - NOW.getTime();
    expect(passOnce(fresh)).toBe(90 * 60_000);                                                        // never failed: proving
    expect(passOnce({ ...fresh, everFailed: true })).toBe(6 * HOUR);                                  // has failed: normal cadence for good
    expect(passOnce({ ...fresh, consecutivePasses: PROMOTION_PASSES - 1 })).toBe(6 * HOUR);           // this pass completes the streak
    expect(passOnce(fresh, { alreadyInLiteLLM: true })).toBe(6 * HOUR);                               // already added
  });
});

describe("promotion gate (I8)", () => {
  it("requires 5 consecutive passes", () => {
    expect(promotionGateReason({ consecutivePasses: 5, lastCheckStatus: "available", previouslyInLiteLLM: false })).toBeNull();
    expect(promotionGateReason({ consecutivePasses: 12, lastCheckStatus: "available", previouslyInLiteLLM: false })).toBeNull();
    expect(promotionGateReason({ consecutivePasses: 4, lastCheckStatus: "available", previouslyInLiteLLM: false })).toBe("4 of 5 passes in a row");
    expect(promotionGateReason({ consecutivePasses: 0, lastCheckStatus: "unavailable", previouslyInLiteLLM: false })).toBe("0 of 5 passes in a row");
    expect(promotionGateReason({ consecutivePasses: 0, lastCheckStatus: null, previouslyInLiteLLM: false })).toBe("Not tested yet");
  });

  it("keeps the human-override path for a model that was in LiteLLM and removed: its latest check merely has to pass", () => {
    expect(promotionGateReason({ consecutivePasses: 1, lastCheckStatus: "available", previouslyInLiteLLM: true })).toBeNull();
    expect(promotionGateReason({ consecutivePasses: 0, lastCheckStatus: "unavailable", previouslyInLiteLLM: true })).toBe("0 of 5 passes in a row");
  });
});

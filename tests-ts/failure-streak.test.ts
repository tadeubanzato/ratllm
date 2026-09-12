import { describe, expect, it } from "vitest";
import { computeFailureStreak } from "../src/server/health/failure-streak";

const failed = (errorCode: string | null = "UNAVAILABLE") => ({status: "FAILED", errorCode});
const passed = () => ({status: "PASSED", errorCode: "HEALTHY"});
const rateLimited = () => ({status: "FAILED", errorCode: "RATE_LIMITED"});

describe("computeFailureStreak", () => {
  it("counts 5 genuine consecutive failures as a full streak", () => {
    expect(computeFailureStreak([failed(), failed(), failed(), failed(), failed()])).toBe(5);
  });

  it("stops at the first PASSED (most-recent-first order)", () => {
    expect(computeFailureStreak([failed(), failed(), passed(), failed(), failed()])).toBe(2);
  });

  it("never lets sustained rate-limiting alone build a removal streak", () => {
    expect(computeFailureStreak([rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited()])).toBe(0);
  });

  it("skips rate-limited rows without breaking a genuine failure streak spanning them", () => {
    expect(computeFailureStreak([failed(), rateLimited(), failed(), failed(), rateLimited(), failed(), failed()])).toBe(5);
  });

  it("caps at AUTO_REMOVE_AFTER_FAILURES even given a longer genuine streak", () => {
    expect(computeFailureStreak(Array.from({length: 10}, () => failed()))).toBe(5);
  });
});
